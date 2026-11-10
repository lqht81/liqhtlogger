/*
 * LiqhtLogger — Panel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { MessageStore, Modal, NavigationRouter, openModal, useEffect, useMemo, useState } from "@webpack/common";

import { avatarUrl, dayStr, flush, getAccount, isRecordHidden, keyOf, logger, Native, parseContent, removeFromLog, settings, whereText } from ".";

const PAGE = 100;

type Tab = "deleted" | "edited";

export function openPanel() {
    openModal((props: any) => (
        <ErrorBoundary>
            <Panel modalProps={props} />
        </ErrorBoundary>
    ));
}

// ─────────────────────────── Yardımcılar ───────────────────────────

const lower = (s: any) => String(s ?? "").toLocaleLowerCase("tr");

function dayLabel(t: number) {
    const d = new Date(t);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return "Bugün";
    if (d.toDateString() === yesterday.toDateString()) return "Dün";
    return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric", weekday: "long" });
}

function fullTime(t: any) {
    if (!t) return "?";
    return new Date(t).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac"
};

function mimeOf(filename: string, contentType?: string) {
    if (contentType) return contentType;
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return MIME[ext] ?? "application/octet-stream";
}

function kindOf(mime: string) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
}

function formatSize(bytes?: number) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─────────────────────────── Kaydedilmiş dosya önizleme ───────────────────────────

function LocalMedia({ path, att }: { path: string; att: any; }) {
    const mime = mimeOf(att.filename, att.contentType);
    const kind = kindOf(mime);
    // Resimler otomatik yüklenir, video/ses tıklayınca
    const [open, setOpen] = useState(kind === "image");
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!open) return;
        let objectUrl: string | undefined;
        let alive = true;
        Native.readMedia(path)
            .then((data: any) => {
                if (!alive) return;
                if (!data) { setFailed(true); return; }
                objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
                setUrl(objectUrl);
            })
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [open, path]);

    return (
        <div className="liqht-p-file">
            {open && url && kind === "image" && <img className="liqht-p-media" src={url} alt={att.filename} />}
            {open && url && kind === "video" && <video className="liqht-p-media" src={url} controls />}
            {open && url && kind === "audio" && <audio src={url} controls />}

            <div className="liqht-p-file-row">
                <span>📎 {att.filename} <span className="liqht-p-muted">{formatSize(att.size)}</span></span>
                {!open && (kind === "video" || kind === "audio") && (
                    <button className="liqht-p-btn" onClick={() => setOpen(true)}>▶ Oynat</button>
                )}
                {failed && <span className="liqht-p-muted">açılamadı</span>}
                <button className="liqht-p-btn" onClick={() => Native.showFile(path)}>Klasörde göster</button>
            </div>
        </div>
    );
}

function Attachments({ rec, media }: { rec: any; media: string[]; }) {
    if (!rec.attachments?.length) return null;
    return (
        <div className="liqht-p-files">
            {rec.attachments.map((a: any) => {
                const path = media.find(p => p.includes(`_${a.id}_`));
                return path
                    ? <LocalMedia key={a.id} path={path} att={a} />
                    : (
                        <div key={a.id} className="liqht-p-file-row liqht-p-muted">
                            📎 {a.filename} {formatSize(a.size)} — kaydedilmedi
                        </div>
                    );
            })}
        </div>
    );
}

// ─────────────────────────── Tek kayıt ───────────────────────────

function Item({ rec, media, onRemove, onGo }: { rec: any; media: string[]; onRemove(): void; onGo(): void; }) {
    const msgLike = { id: rec.messageId, channel_id: rec.channelId };
    const label =
        rec.type === "edit" ? "Düzenlendi" :
            rec.type === "attachment" ? "Ek silindi" :
                "Silindi";

    return (
        <div className={`liqht-p-item liqht-p-${rec.type}`}>
            <img className="liqht-p-avatar" src={avatarUrl(rec)} alt="" />
            <div className="liqht-p-body">
                <div className="liqht-p-head">
                    <span className="liqht-p-author">{rec.authorName}</span>
                    {rec.ghost && <span className="liqht-p-tag liqht-p-ghost">👻 seni etiketledi</span>}
                    {rec.bulk && <span className="liqht-p-tag">toplu silme</span>}
                    <span className="liqht-p-where">{whereText(rec)}</span>
                </div>
                <div className="liqht-p-times">
                    Gönderildi {fullTime(rec.sentAt)} · <b>{label} {fullTime(rec.at)}</b>
                </div>

                {rec.type === "edit" ? (
                    <div className="liqht-p-editbox">
                        <div className="liqht-p-old">{rec.content ? parseContent(rec.content, msgLike) : <i>[boş]</i>}</div>
                        <div className="liqht-p-arrow">↓</div>
                        <div className="liqht-p-new">{rec.newContent ? parseContent(rec.newContent, msgLike) : <i>[boş]</i>}</div>
                    </div>
                ) : (
                    rec.content && rec.type === "delete" && <div className="liqht-p-content">{parseContent(rec.content, msgLike)}</div>
                )}

                {rec.type !== "edit" && <Attachments rec={rec} media={media} />}

                <div className="liqht-p-actions">
                    <button className="liqht-p-btn" onClick={onGo}>Kanala git</button>
                    <button className="liqht-p-btn liqht-p-danger" onClick={onRemove}>Logdan kaldır</button>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────── Panel ───────────────────────────

function Panel({ modalProps }: { modalProps: any; }) {
    const [records, setRecords] = useState<any[] | null>(null);
    const [media, setMedia] = useState<Record<string, string[]>>({});
    const [tab, setTab] = useState<Tab>("deleted");
    const [scope, setScope] = useState("all");     // all | dm | <guildId>
    const [channel, setChannel] = useState("all"); // all | <channelId>
    const [user, setUser] = useState("");
    const [text, setText] = useState("");
    const [limit, setLimit] = useState(PAGE);
    const [showHidden, setShowHidden] = useState(false);

    // Kayıtları diskten oku (panel her açıldığında; diğer Discord'un yazdıkları da gelir)
    useEffect(() => {
        let alive = true;
        (async () => {
            await flush();
            const acc = getAccount();
            if (!acc) { if (alive) setRecords([]); return; }
            const logDays = Math.max(1, Number(settings.store.logDays) || 30);
            const since = dayStr(new Date(Date.now() - logDays * 86_400_000));
            const [lines, mediaMap] = await Promise.all([Native.readRecords(acc, since), Native.listMedia(acc)]);

            const seen = new Set<string>();
            const recs: any[] = [];
            for (const line of lines) {
                try {
                    const r = JSON.parse(line);
                    const k = keyOf(r);
                    if (seen.has(k)) continue;
                    seen.add(k);
                    recs.push(r);
                } catch { /* bozuk satır */ }
            }
            recs.sort((a, b) => b.at - a.at);
            if (alive) {
                setRecords(recs);
                setMedia(mediaMap);
            }
        })().catch(e => {
            logger.error("Panel kayıtları okunamadı", e);
            if (alive) setRecords([]);
        });
        return () => { alive = false; };
    }, []);

    // Şu an yoksayılan sunucu/kanal/kullanıcılara ait eski kayıtlar varsayılan olarak gizli
    const hiddenCount = useMemo(() => (records ?? []).filter(isRecordHidden).length, [records]);
    const visible = useMemo(() => showHidden ? records ?? [] : (records ?? []).filter(r => !isRecordHidden(r)), [records, showHidden]);

    const tabRecs = useMemo(() => visible.filter(r =>
        tab === "edited" ? r.type === "edit" : r.type === "delete" || r.type === "attachment"
    ), [visible, tab]);

    // Filtre seçenekleri (sadece kayıtlarda geçen sunucu/kanallar)
    const guildOptions = useMemo(() => {
        const m = new Map<string, string>();
        for (const r of tabRecs) if (r.guildId) m.set(r.guildId, r.guildName ?? r.guildId);
        return [...m].sort((a, b) => a[1].localeCompare(b[1], "tr"));
    }, [tabRecs]);

    const channelOptions = useMemo(() => {
        const m = new Map<string, string>();
        for (const r of tabRecs) {
            if (scope === "dm" ? r.guildId : scope !== "all" && r.guildId !== scope) continue;
            m.set(r.channelId, r.guildId ? `#${r.channelName ?? r.channelId}` : r.channelName ?? "DM");
        }
        return [...m].sort((a, b) => a[1].localeCompare(b[1], "tr"));
    }, [tabRecs, scope]);

    const filtered = useMemo(() => {
        const u = lower(user.trim());
        const t = lower(text.trim());
        return tabRecs.filter(r => {
            if (scope === "dm" && r.guildId) return false;
            if (scope !== "all" && scope !== "dm" && r.guildId !== scope) return false;
            if (channel !== "all" && r.channelId !== channel) return false;
            if (u && !lower(r.authorName).includes(u) && !lower(r.authorUsername).includes(u) && r.authorId !== user.trim()) return false;
            if (t && !lower(r.content).includes(t) && !lower(r.newContent).includes(t)
                && !(r.attachments ?? []).some((a: any) => lower(a.filename).includes(t))) return false;
            return true;
        });
    }, [tabRecs, scope, channel, user, text]);

    useEffect(() => setLimit(PAGE), [tab, scope, channel, user, text]);

    const counts = useMemo(() => {
        const all = visible;
        return {
            deleted: all.filter(r => r.type !== "edit").length,
            edited: all.filter(r => r.type === "edit").length
        };
    }, [visible]);

    const remove = (rec: any) => {
        const live: any = MessageStore.getMessage(rec.channelId, rec.messageId);
        removeFromLog(live ?? { id: rec.messageId, channel_id: rec.channelId, deleted: rec.type === "delete" });
        setRecords(prev => (prev ?? []).filter(r => r.messageId !== rec.messageId));
    };

    const go = (rec: any) => {
        NavigationRouter.transitionTo(`/channels/${rec.guildId ?? "@me"}/${rec.channelId}`);
        modalProps.onClose?.();
    };

    // Günlere göre grupla
    const shown = filtered.slice(0, limit);
    const groups: [string, any[]][] = [];
    for (const r of shown) {
        const label = dayLabel(r.at);
        const last = groups[groups.length - 1];
        if (last && last[0] === label) last[1].push(r);
        else groups.push([label, [r]]);
    }

    return (
        <Modal {...modalProps} size="lg" title="LiqhtLogger">
            <div className="liqht-p">
                <div className="liqht-p-tabs">
                    <button className={`liqht-p-tab ${tab === "deleted" ? "active" : ""}`} onClick={() => setTab("deleted")}>
                        🗑 Silinenler <span className="liqht-p-count">{counts.deleted}</span>
                    </button>
                    <button className={`liqht-p-tab ${tab === "edited" ? "active" : ""}`} onClick={() => setTab("edited")}>
                        ✏️ Düzenlenenler <span className="liqht-p-count">{counts.edited}</span>
                    </button>
                    <div style={{ flex: 1 }} />
                    <button className="liqht-p-btn" onClick={() => { const acc = getAccount(); if (acc) Native.openFolder(acc); }}>📂 Klasörü aç</button>
                </div>

                <div className="liqht-p-filters">
                    <select value={scope} onChange={e => { setScope(e.currentTarget.value); setChannel("all"); }}>
                        <option value="all">Tümü (sunucular + DM)</option>
                        <option value="dm">Sadece DM'ler</option>
                        {guildOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                    <select value={channel} onChange={e => setChannel(e.currentTarget.value)}>
                        <option value="all">Tüm kanallar</option>
                        {channelOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                    <input placeholder="Kullanıcı adı veya ID" value={user} onChange={e => setUser(e.currentTarget.value)} />
                    <input placeholder="Mesajda ara..." value={text} onChange={e => setText(e.currentTarget.value)} />
                </div>

                {hiddenCount > 0 && (
                    <label className="liqht-p-hidden">
                        <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.currentTarget.checked)} />
                        Yoksayılan sunucu/kanal/kullanıcılara ait {hiddenCount} eski kaydı da göster
                    </label>
                )}

                <div className="liqht-p-list">
                    {records === null && <div className="liqht-p-empty">Yükleniyor...</div>}
                    {records !== null && !filtered.length && <div className="liqht-p-empty">Kayıt bulunamadı.</div>}

                    {groups.map(([label, recs]) => (
                        <div key={label}>
                            <div className="liqht-p-day">{label}</div>
                            {recs.map(r => (
                                <Item
                                    key={keyOf(r)}
                                    rec={r}
                                    media={media[r.messageId] ?? []}
                                    onRemove={() => remove(r)}
                                    onGo={() => go(r)}
                                />
                            ))}
                        </div>
                    ))}

                    {filtered.length > limit && (
                        <button className="liqht-p-btn liqht-p-more" onClick={() => setLimit(limit + PAGE)}>
                            Daha fazla göster ({filtered.length - limit} kaldı)
                        </button>
                    )}
                </div>

                <div className="liqht-p-footer liqht-p-muted">
                    {filtered.length} kayıt · son {settings.store.logDays} gün
                </div>
            </div>
        </Modal>
    );
}
