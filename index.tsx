/*
 * LiqhtLogger — Vencord userplugin
 * Vencord'un MessageLogger plugininden uyarlanmıştır
 * (Copyright (c) 2022 Vendicated and contributors).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ApplicationCommandInputType } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { AuthenticationStore, ChannelStore, FluxDispatcher, GuildStore, Menu, MessageStore, Parser, SelectedChannelStore, showToast, UserStore, useState, useStateFromStores } from "@webpack/common";

import { openPanel } from "./panel";

export const Native = VencordNative.pluginHelpers.LiqhtLogger as PluginNative<typeof import("./native")>;
export const logger = new Logger("LiqhtLogger");

const EPHEMERAL = 64;          // "Sadece sen görebilirsin" mesaj bayrağı
const OWN_CACHE_MAX = 5000;    // arka plan önbelleğinde tutulacak en fazla mesaj

// ─────────────────────────── Ayarlar ───────────────────────────

export const settings = definePluginSettings({
    logDays: {
        type: OptionType.NUMBER,
        description: "Mesaj kayıtları kaç gün saklansın",
        default: 30,
        onChange: () => pruneNow()
    },
    logAreas: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <LogAreas />
    },
    ignoreUsers: {
        type: OptionType.STRING,
        description: "Yoksayılacak kullanıcı ID'leri (virgülle ayır). Kullanıcıya sağ tıklayıp \"LiqhtLogger: Bu kullanıcıyı yoksay\" ile de eklenebilir.",
        default: ""
    },
    ignoreChannels: {
        type: OptionType.STRING,
        description: "Yoksayılacak kanal veya kategori ID'leri (virgülle ayır). Kanala sağ tıklayıp \"LiqhtLogger: Bu kanalı yoksay\" ile de eklenebilir.",
        default: ""
    },
    mediaDays: {
        type: OptionType.NUMBER,
        description: "İndirilen dosyalar (resim, video vb.) kaç gün saklansın",
        default: 7,
        onChange: () => pruneNow()
    },
    downloadAreas: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <DownloadAreas />
    },
    maxFileMB: {
        type: OptionType.NUMBER,
        description: "Bir dosya en fazla kaç MB ise indirilsin (daha büyükler atlanır)",
        default: 50
    },
    cacheMaxGB: {
        type: OptionType.NUMBER,
        description: "Önceden indirilen (henüz silinmemiş) dosyalar en fazla kaç GB yer kaplasın. Aşılırsa en eskiler silinir.",
        default: 2
    },
    notifyMode: {
        type: OptionType.SELECT,
        description: "Bir mesaj silindiğinde bildirim gönder",
        options: [
            { label: "Kapalı", value: "off" },
            { label: "Sadece DM'ler", value: "dm", default: true },
            { label: "DM'ler + aşağıda yazdığım kişi/kanal/sunucular", value: "dmPlus" },
            { label: "Hepsi (kalabalık sunucularda çok bildirim gelir)", value: "all" }
        ]
    },
    notifyIds: {
        type: OptionType.STRING,
        description: "\"DM'ler + ...\" seçiliyken bildirim gelecek kullanıcı, kanal veya sunucu ID'leri (virgülle ayır)",
        default: ""
    },
    notifyEdits: {
        type: OptionType.BOOLEAN,
        description: "Düzenlenen mesajlar için de aynı kurallarla bildirim gönder",
        default: false
    },
    ghostPing: {
        type: OptionType.BOOLEAN,
        description: "👻 Hayalet etiket: Beni etiketleyen bir mesaj silinirse, bildirim ayarı ne olursa olsun haber ver",
        default: true
    },
    toolbarButton: {
        type: OptionType.BOOLEAN,
        description: "Sağ üstteki Gelen Kutusu ikonunun soluna LiqhtLogger paneli butonu ekle",
        default: true,
        onChange: () => ensureToolbarButton()
    },
    logDeletes: {
        type: OptionType.BOOLEAN,
        description: "Silinen mesajları kaydet",
        default: true
    },
    logEdits: {
        type: OptionType.BOOLEAN,
        description: "Düzenlenen mesajları kaydet",
        default: true
    },
    inlineEdits: {
        type: OptionType.BOOLEAN,
        description: "Düzenlenen mesajın eski halini mesajın üstünde soluk göster",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Bot mesajlarını yoksay",
        default: true
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Kendi mesajlarımı yoksay",
        default: false
    }
}).withPrivateSettings<{
    // Ayar sayfasında doğrudan görünmeyen, DownloadAreas bileşeninin yönettiği değerler
    dmAll?: boolean;
    guildsEnabled?: boolean;
    guildMode?: "all" | "selected";
    guilds?: string[];
    migrated?: boolean;
    // LogAreas bileşeninin yönettiği değerler
    logDMs?: boolean;
    logGuildMode?: "all" | "selected";
    logExcluded?: string[];   // "all" modunda kaydedilmeyecek sunucular
    logSelected?: string[];   // "selected" modunda kaydedilecek sunucular
    migratedAccounts?: string[]; // eski ortak kayıtları aktarılmış hesaplar
}>();

function logPrefs() {
    const s = settings.store;
    return {
        logDMs: s.logDMs ?? true,
        logGuildMode: s.logGuildMode ?? "all",
        logExcluded: s.logExcluded ?? [],
        logSelected: s.logSelected ?? []
    };
}

/** Bu kanal (sunucusu, kategorisi) yoksayılıyor mu? */
function isLocationIgnored(channelId: string) {
    const ch: any = ChannelStore.getChannel(channelId);
    const ignored = idList(settings.store.ignoreChannels);
    if (ignored.includes(channelId)) return true;
    if (ch?.parent_id) {
        if (ignored.includes(ch.parent_id)) return true;
        // Thread ise ana kanalın kategorisine de bak
        const parent: any = ChannelStore.getChannel(ch.parent_id);
        if (parent?.parent_id && ignored.includes(parent.parent_id)) return true;
    }
    if (!ch) return false; // bilinmeyen kanal: kaydet

    const p = logPrefs();
    const gid: string | undefined = ch.guild_id;
    if (!gid) return !p.logDMs;
    return p.logGuildMode === "all" ? p.logExcluded.includes(gid) : !p.logSelected.includes(gid);
}

function isGuildLogged(guildId: string) {
    const p = logPrefs();
    return p.logGuildMode === "all" ? !p.logExcluded.includes(guildId) : p.logSelected.includes(guildId);
}

/** Kayıt şu anki yoksayma ayarlarına göre gizlenmeli mi? (eski kayıtlar için: panel, geri yükleme, aktarma) */
export function isRecordHidden(rec: any) {
    if (rec?.authorId && idList(settings.store.ignoreUsers).includes(rec.authorId)) return true;
    if (!rec?.channelId) return false;
    if (ChannelStore.getChannel(rec.channelId)) return isLocationIgnored(rec.channelId);
    // Kanal artık yok/erişilemiyor: kayıttaki sunucu bilgisine göre karar ver
    const p = logPrefs();
    if (!rec.guildId) return !p.logDMs;
    return p.logGuildMode === "all" ? p.logExcluded.includes(rec.guildId) : !p.logSelected.includes(rec.guildId);
}

function setGuildLogged(guildId: string, logged: boolean) {
    const p = logPrefs();
    if (p.logGuildMode === "all")
        settings.store.logExcluded = logged ? p.logExcluded.filter(x => x !== guildId) : [...new Set([...p.logExcluded, guildId])];
    else
        settings.store.logSelected = logged ? [...new Set([...p.logSelected, guildId])] : p.logSelected.filter(x => x !== guildId);
}

/** Virgüllü ID listesine ekler / çıkarır */
function toggleId(key: "ignoreUsers" | "ignoreChannels", id: string) {
    const list = idList(settings.store[key]);
    settings.store[key] = (list.includes(id) ? list.filter(x => x !== id) : [...list, id]).join(", ");
}

/** Aranabilir, işaretlenebilir sunucu listesi */
function GuildPicker({ selected, onToggle }: { selected: string[]; onToggle(id: string): void; }) {
    const [search, setSearch] = useState("");
    const guilds = Object.values(GuildStore.getGuilds() as Record<string, any>)
        .sort((a, b) => a.name.localeCompare(b.name, "tr"))
        .filter(g => !search || g.name.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")));

    return (
        <>
            <input
                className="liqht-areas-search"
                placeholder="Sunucu ara..."
                value={search}
                onChange={e => setSearch(e.currentTarget.value)}
            />
            <div className="liqht-areas-list">
                {guilds.map(g => (
                    <label key={g.id} className="liqht-areas-guild">
                        <input type="checkbox" checked={selected.includes(g.id)} onChange={() => onToggle(g.id)} />
                        {g.name}
                    </label>
                ))}
            </div>
        </>
    );
}

/** Ayarlardaki "Kaydedilecek alanlar" bölümü */
function LogAreas() {
    const initial = logPrefs();
    const [logDMs, setLogDMs] = useState(initial.logDMs);
    const [mode, setMode] = useState(initial.logGuildMode);
    const [excluded, setExcluded] = useState<string[]>(initial.logExcluded);
    const [selected, setSelected] = useState<string[]>(initial.logSelected);

    const toggle = (id: string) => {
        if (mode === "all") {
            const next = excluded.includes(id) ? excluded.filter(x => x !== id) : [...excluded, id];
            setExcluded(next);
            settings.store.logExcluded = next;
        } else {
            const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
            setSelected(next);
            settings.store.logSelected = next;
        }
    };

    return (
        <div className="liqht-areas">
            <div className="liqht-areas-title">Kaydedilecek Alanlar</div>
            <div className="liqht-areas-desc">Silinen ve düzenlenen mesajların nerelerde kaydedileceği. Yoksayılan yerlerde mesajlar normal şekilde silinir.</div>

            <label className="liqht-areas-row">
                <input
                    type="checkbox"
                    checked={logDMs}
                    onChange={e => { setLogDMs(e.currentTarget.checked); settings.store.logDMs = e.currentTarget.checked; }}
                />
                <div className="liqht-areas-label">DM ve grup DM mesajları</div>
            </label>

            <div className="liqht-areas-label">Sunucular</div>
            <div className="liqht-areas-guilds">
                <label className="liqht-areas-radio">
                    <input type="radio" checked={mode === "all"} onChange={() => { setMode("all"); settings.store.logGuildMode = "all"; }} />
                    Tüm sunucular, işaretlediklerim hariç ({excluded.length} hariç)
                </label>
                <label className="liqht-areas-radio">
                    <input type="radio" checked={mode === "selected"} onChange={() => { setMode("selected"); settings.store.logGuildMode = "selected"; }} />
                    Sadece işaretlediğim sunucular ({selected.length} seçili)
                </label>

                <div className="liqht-areas-desc">
                    {mode === "all" ? "Kaydedilmeyecek sunucuları işaretle:" : "Kaydedilecek sunucuları işaretle:"}
                </div>
                <GuildPicker selected={mode === "all" ? excluded : selected} onToggle={toggle} />
            </div>
        </div>
    );
}

function downloadPrefs() {
    const s = settings.store;
    return {
        dmAll: s.dmAll ?? true,
        guildsEnabled: s.guildsEnabled ?? false,
        guildMode: s.guildMode ?? "all",
        guilds: s.guilds ?? []
    };
}

/** Ayarlardaki "Dosya kaydetme alanları" bölümü */
function DownloadAreas() {
    const initial = downloadPrefs();
    const [dmAll, setDmAll] = useState(initial.dmAll);
    const [guildsEnabled, setGuildsEnabled] = useState(initial.guildsEnabled);
    const [guildMode, setGuildMode] = useState(initial.guildMode);
    const [selected, setSelected] = useState<string[]>(initial.guilds);

    const toggleGuild = (id: string) => {
        const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
        setSelected(next);
        settings.store.guilds = next;
    };

    return (
        <div className="liqht-areas">
            <div className="liqht-areas-title">Dosya Kaydetme Alanları</div>
            <div className="liqht-areas-desc">Silinen tüm dosya türleri için dosyayı direkt kaydedeceği alanlar.</div>

            <label className="liqht-areas-row">
                <input
                    type="checkbox"
                    checked={dmAll}
                    onChange={e => { setDmAll(e.currentTarget.checked); settings.store.dmAll = e.currentTarget.checked; }}
                />
                <div>
                    <div className="liqht-areas-label">DM Mesajları <span className="liqht-areas-badge">önerilen</span></div>
                    <div className="liqht-areas-desc">Kapalıyken sadece gördüğünüz DM mesajlarının dosyaları, sonradan silinirse kaydedilir.</div>
                </div>
            </label>

            <label className="liqht-areas-row">
                <input
                    type="checkbox"
                    checked={guildsEnabled}
                    onChange={e => { setGuildsEnabled(e.currentTarget.checked); settings.store.guildsEnabled = e.currentTarget.checked; }}
                />
                <div>
                    <div className="liqht-areas-label">Sunucular</div>
                    <div className="liqht-areas-desc">
                        Açılırsa görmediğiniz mesajları da indireceği için yük binebilir. Sadece DM önerilir.
                        Kapalıyken sunucularda sadece gördüğünüz mesajların dosyaları, sonradan silinirse kaydedilir.
                    </div>
                </div>
            </label>

            {guildsEnabled && (
                <div className="liqht-areas-guilds">
                    <label className="liqht-areas-radio">
                        <input
                            type="radio"
                            checked={guildMode === "all"}
                            onChange={() => { setGuildMode("all"); settings.store.guildMode = "all"; }}
                        />
                        Tüm sunucular
                    </label>
                    <label className="liqht-areas-radio">
                        <input
                            type="radio"
                            checked={guildMode === "selected"}
                            onChange={() => { setGuildMode("selected"); settings.store.guildMode = "selected"; }}
                        />
                        Sadece seçtiğim sunucular ({selected.length} seçili)
                    </label>

                    {guildMode === "selected" && <GuildPicker selected={selected} onToggle={toggleGuild} />}
                </div>
            )}
        </div>
    );
}

// ─────────────────────────── Tipler ───────────────────────────

interface AttachmentInfo {
    id: string;
    filename: string;
    url: string;
    proxyUrl?: string;
    size: number;
    contentType?: string;
}

/** Mesajın kayıt için sadeleştirilmiş kopyası */
interface Snap {
    id: string;
    channelId: string;
    content: string;
    authorId?: string;
    authorName: string;
    authorUsername: string;
    authorAvatar: string | null;
    bot: boolean;
    sentAt: number | null;
    flags: number;
    mentionIds: string[];
    attachments: AttachmentInfo[];
}

type RecordType = "delete" | "edit" | "attachment";

// ─────────────────────────── Yardımcılar ───────────────────────────

/** Hem Discord'un MessageRecord'unu hem de ham gateway mesajını Snap'e çevirir */
function snapshot(msg: any): Snap {
    const author = msg.author ?? {};
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : NaN;
    return {
        id: msg.id,
        channelId: msg.channel_id,
        content: msg.content ?? "",
        authorId: author.id,
        authorName: author.globalName ?? author.global_name ?? author.username ?? "?",
        authorUsername: author.username ?? "?",
        authorAvatar: author.avatar ?? null,
        bot: !!author.bot,
        sentAt: Number.isFinite(ts) ? ts : null,
        flags: msg.flags ?? 0,
        mentionIds: (msg.mentions ?? []).map((m: any) => typeof m === "string" ? m : m?.id).filter(Boolean),
        attachments: (msg.attachments ?? []).map((a: any) => ({
            id: a.id,
            filename: a.filename,
            url: a.url,
            proxyUrl: a.proxy_url ?? a.proxyURL ?? a.proxyUrl,
            size: a.size,
            contentType: a.content_type ?? a.contentType
        }))
    };
}

/** Kanalın sunucu/kanal/DM adını bulur (kayıt anında saklanır, sonradan isim değişse de kalır) */
function locate(channelId: string) {
    const ch: any = ChannelStore.getChannel(channelId);
    const guildId: string | null = ch?.guild_id ?? null;

    if (guildId)
        return { guildId, guildName: GuildStore.getGuild(guildId)?.name ?? null, channelName: ch?.name ?? null };

    if (ch?.isGroupDM?.())
        return { guildId: null, guildName: null, channelName: ch.name || "Grup DM" };

    const otherId = ch?.recipients?.[0];
    const other = otherId ? UserStore.getUser(otherId) : null;
    return { guildId: null, guildName: null, channelName: other ? `DM: ${other.username}` : "DM" };
}

function myId() {
    return UserStore.getCurrentUser()?.id;
}

function isIgnored(s: Snap, isEdit: boolean) {
    const { ignoreBots, ignoreSelf, logEdits, logDeletes } = settings.store;
    if (isEdit ? !logEdits : !logDeletes) return true;
    if (ignoreBots && s.bot) return true;
    if (ignoreSelf && s.authorId === myId()) return true;
    if (s.authorId && idList(settings.store.ignoreUsers).includes(s.authorId)) return true;
    if (isLocationIgnored(s.channelId)) return true;
    return false;
}

export function dayStr(d: Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "01:42" (bugünse) veya "09.11 01:42" */
export function fmt(t: any) {
    if (!t) return "";
    const d = new Date(t);
    const isToday = d.toDateString() === new Date().toDateString();
    return isToday
        ? d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function parseContent(content: string, message: any) {
    return Parser.parse(content, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

function hash(str: string) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/** Kaydın benzersiz anahtarı: iki Discord aynı olayı yazarsa aynı anahtarı üretir */
export function keyOf(rec: any): string {
    if (rec.k) return rec.k;
    switch (rec.type) {
        case "delete": return `d_${rec.messageId}`;
        case "edit": return `e_${rec.messageId}_${hash(`${rec.content}\u0000${rec.newContent}`)}`;
        default: return `a_${rec.messageId}_${hash((rec.attachments ?? []).map((a: any) => a.id).join("-"))}`;
    }
}

export function avatarUrl(rec: any) {
    if (rec.authorId && rec.authorAvatar)
        return `https://cdn.discordapp.com/avatars/${rec.authorId}/${rec.authorAvatar}.webp?size=64`;
    let n = 0;
    try { n = Number((BigInt(rec.authorId ?? 0) >> 22n) % 6n); } catch { /* yoksay */ }
    return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

export function whereText(rec: any) {
    return rec.guildId
        ? `${rec.guildName ?? "Sunucu"} › #${rec.channelName ?? "?"}`
        : rec.channelName ?? "DM";
}

function idList(str: string) {
    return String(str || "").split(/[\s,]+/).filter(Boolean);
}

// ─────────────────────────── Diske yazma (toplu) ───────────────────────────
// Her kaydı ayrı ayrı yazmak yerine 1 saniyede bir toplu yazıyoruz.

let queue: Record<string, string[]> = {};
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function queueRecord(rec: Record<string, any>) {
    const day = dayStr(new Date(rec.at));
    (queue[day] ??= []).push(JSON.stringify(rec));
    if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

export async function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!account) return; // hesap henüz belli değil, kuyrukta beklesin
    const pending = queue;
    queue = {};
    for (const [day, lines] of Object.entries(pending)) {
        try {
            await Native.appendRecords(account, day, lines);
        } catch (e) {
            logger.error("Kayıt dosyaya yazılamadı", e);
        }
    }
}

function writeRecord(type: RecordType, s: Snap, at: number, extra: Record<string, any> = {}) {
    const me = myId();
    const rec: any = {
        type,
        at,
        messageId: s.id,
        channelId: s.channelId,
        ...locate(s.channelId),
        authorId: s.authorId,
        authorName: s.authorName,
        authorUsername: s.authorUsername,
        authorAvatar: s.authorAvatar,
        sentAt: s.sentAt,
        content: s.content,
        attachments: s.attachments,
        ...extra
    };
    if (type !== "edit" && me && s.authorId !== me && s.mentionIds.includes(me)) rec.ghost = true;
    rec.k = keyOf(rec);

    queueRecord(rec);
    indexRecord(rec);
    if (type !== "edit") saveAttachments(s, at);
    maybeNotify(rec);
}

// ─────────────────────────── Bildirimler ───────────────────────────

function maybeNotify(rec: any) {
    try {
        if (rec.bulk) return;
        const me = myId();
        if (rec.authorId && rec.authorId === me) return;

        const { notifyMode, notifyIds, notifyEdits, ghostPing } = settings.store;
        let ok = !!(ghostPing && rec.ghost);

        if (!ok && notifyMode !== "off" && (rec.type !== "edit" || notifyEdits)) {
            if (notifyMode === "all") ok = true;
            else if (!rec.guildId) ok = true; // DM
            else if (notifyMode === "dmPlus") {
                const ids = idList(notifyIds);
                ok = ids.includes(rec.authorId) || ids.includes(rec.channelId) || ids.includes(rec.guildId);
            }
        }
        if (!ok) return;

        // İki Discord açıksa bildirimi sadece biri göstersin
        if (!account) return;
        Native.claim(account, "n_" + rec.k).then(won => {
            if (!won) return;
            const title =
                rec.ghost ? "👻 Hayalet etiket" :
                    rec.type === "edit" ? "✏️ Mesaj düzenlendi" :
                        rec.type === "attachment" ? "📎 Ek silindi" :
                            "🗑 Mesaj silindi";

            const text = rec.type === "edit"
                ? `${rec.content || "[boş]"}  →  ${rec.newContent || "[boş]"}`
                : rec.content || (rec.attachments?.length ? rec.attachments.map((a: any) => `📎 ${a.filename}`).join(", ") : "[içerik yok]");

            showNotification({
                title: `${title} · ${rec.authorName}`,
                body: `${whereText(rec)}\n${text.length > 200 ? text.slice(0, 200) + "…" : text}`,
                icon: avatarUrl(rec),
                onClick: () => openPanel()
            });
        }).catch(() => { });
    } catch (e) {
        logger.error("Bildirim hatası", e);
    }
}

// ─────────────────────────── Dosya indirme ───────────────────────────
// 1) Önceden indirme: mesaj gelir gelmez dosyayı media\_cache'e indir.
// 2) Silinince: önbellekte varsa media\<gün>'e taşı, yoksa o an indirmeyi dene.

const MAX_PARALLEL = 3;
const jobs: (() => Promise<unknown>)[] = [];
let activeJobs = 0;
const seenAttachments = new Set<string>();

function enqueue(job: () => Promise<unknown>) {
    jobs.push(job);
    pump();
}

function pump() {
    while (activeJobs < MAX_PARALLEL && jobs.length) {
        const job = jobs.shift()!;
        activeJobs++;
        job()
            .catch(e => logger.error("İndirme hatası", e))
            .finally(() => { activeJobs--; pump(); });
    }
}

function maxBytes() {
    return Math.max(1, Number(settings.store.maxFileMB) || 50) * 1024 * 1024;
}

function maxCacheBytes() {
    return Math.max(0.1, Number(settings.store.cacheMaxGB) || 2) * 1024 * 1024 * 1024;
}

function urlsOf(a: any): string[] {
    return [a.url, a.proxy_url ?? a.proxyURL ?? a.proxyUrl].filter(Boolean);
}

/** Bu kanala yeni gelen mesajın dosyaları önceden indirilsin mi? */
function shouldPrecache(channelId: string, guildId?: string | null) {
    const ch: any = ChannelStore.getChannel(channelId);
    const gid: string | null = ch?.guild_id ?? guildId ?? null;
    const seen = channelId === SelectedChannelStore.getChannelId(); // şu an açık olan kanal
    const p = downloadPrefs();

    if (!gid) return p.dmAll || seen;
    if (p.guildsEnabled && (p.guildMode === "all" || p.guilds.includes(gid))) return true;
    return seen;
}

function precache(msg: any) {
    const atts = msg?.attachments;
    if (!atts?.length || !msg.id) return;
    if (settings.store.ignoreBots && msg.author?.bot) return;
    if (msg.author?.id && idList(settings.store.ignoreUsers).includes(msg.author.id)) return;
    if (msg.channel_id && isLocationIgnored(msg.channel_id)) return;

    const acc = account;
    if (!acc) return;
    const max = maxBytes();
    const cacheMax = maxCacheBytes();
    for (const a of atts) {
        if (!a?.id || seenAttachments.has(a.id) || (a.size && a.size > max)) continue;
        seenAttachments.add(a.id);
        enqueue(() => Native.cacheAttachment(acc, msg.id, a.id, a.filename, urlsOf(a), max, cacheMax));
    }
    if (seenAttachments.size > 20000) seenAttachments.clear();
}

function saveAttachments(s: Snap, at: number) {
    const acc = account;
    if (!s.attachments?.length || !acc) return;
    const max = maxBytes();
    const day = dayStr(new Date(at));
    for (const a of s.attachments) {
        if (!a?.id || (a.size && a.size > max)) continue;
        enqueue(async () => {
            const ok = await Native.saveAttachment(acc, s.id, a.id, a.filename, urlsOf(a), max, day);
            if (!ok) logger.warn(`Dosya kaydedilemedi: ${a.filename} (mesaj ${s.id})`);
        });
    }
}

// ─────────────────────────── Hafıza dizini (kanalda geri yükleme) ───────────────────────────
//   deletedIndex: kanalId → (mesajId → silme kaydı)
//   editIndex:    mesajId → [düzenleme kayıtları]

const deletedIndex = new Map<string, Map<string, any>>();
const editIndex = new Map<string, any[]>();
let indexReady = false;

function indexRecord(rec: any) {
    if (!rec?.messageId || !rec.channelId) return;
    if (rec.type === "delete") {
        let byMsg = deletedIndex.get(rec.channelId);
        if (!byMsg) deletedIndex.set(rec.channelId, byMsg = new Map());
        byMsg.set(rec.messageId, rec);
    } else if (rec.type === "edit") {
        let list = editIndex.get(rec.messageId);
        if (!list) editIndex.set(rec.messageId, list = []);
        const k = keyOf(rec);
        if (!list.some(r => keyOf(r) === k)) list.push(rec); // çift kaydı atla
    }
}

function unindex(messageId: string, channelId: string) {
    deletedIndex.get(channelId)?.delete(messageId);
    editIndex.delete(messageId);
}

function unindexChannel(channelId: string) {
    deletedIndex.delete(channelId);
    for (const [id, list] of editIndex)
        if (list[0]?.channelId === channelId) editIndex.delete(id);
}

function guildHasLogs(guildId: string) {
    for (const byMsg of deletedIndex.values()) {
        const first = byMsg.values().next().value;
        if (first?.guildId === guildId) return true;
    }
    for (const list of editIndex.values())
        if (list[0]?.guildId === guildId) return true;
    return false;
}

function unindexGuild(guildId: string) {
    for (const [chId, byMsg] of deletedIndex)
        if (byMsg.values().next().value?.guildId === guildId) deletedIndex.delete(chId);
    for (const [id, list] of editIndex)
        if (list[0]?.guildId === guildId) editIndex.delete(id);
}

function channelHasLogs(channelId: string) {
    if (deletedIndex.get(channelId)?.size) return true;
    for (const list of editIndex.values())
        if (list[0]?.channelId === channelId) return true;
    return false;
}

/** Süresi dolan kayıtları dizinden de çıkar */
function pruneIndex(logDays: number) {
    const cutoff = Date.now() - logDays * 86_400_000;
    for (const [chId, byMsg] of deletedIndex) {
        for (const [id, rec] of byMsg) if (rec.at < cutoff) byMsg.delete(id);
        if (!byMsg.size) deletedIndex.delete(chId);
    }
    for (const [id, list] of editIndex) {
        const kept = list.filter(r => r.at >= cutoff);
        if (kept.length) editIndex.set(id, kept);
        else editIndex.delete(id);
    }
}

async function loadIndex(acc: string) {
    const logDays = Math.max(1, Number(settings.store.logDays) || 30);
    const since = dayStr(new Date(Date.now() - logDays * 86_400_000));
    const t0 = performance.now();
    try {
        const lines = await Native.readRecords(acc, since);
        for (const line of lines) {
            try { indexRecord(JSON.parse(line)); } catch { /* bozuk satırı atla */ }
        }
        logger.info(`${lines.length} kayıt ${Math.round(performance.now() - t0)} ms'de yüklendi (hesap ${acc})`);
    } catch (e) {
        logger.error("Kayıtlar okunamadı", e);
    }
    if (account === acc) indexReady = true;
}

// ─────────────────────────── Hesap ───────────────────────────
// Kayıtlar Discord hesabına göre ayrı klasörlerde tutulur. Discord içinde hesap
// değiştirilirse (CONNECTION_OPEN yeni kullanıcıyla gelir) her şey o hesap için yeniden yüklenir.

let account: string | null = null;

export function getAccount() {
    return account;
}

/** Hesaplara ayırmadan önceki ortak kayıtlardan bu hesabın görebildiği kanallara ait olanları aktarır (hesap başına bir kez) */
async function migrateLegacy(acc: string) {
    const done = settings.store.migratedAccounts ?? [];
    if (done.includes(acc)) return;

    try {
        const lines = await Native.readLegacy();
        if (lines.length) {
            // Kanal listesi yüklensin diye kısa bir bekleme
            await new Promise(r => setTimeout(r, 1500));
            if (account !== acc) return;

            const mine = lines.filter(line => {
                try {
                    const rec = JSON.parse(line);
                    return !!ChannelStore.getChannel(rec.channelId) && !isRecordHidden(rec);
                } catch { return false; }
            });
            if (mine.length) await Native.importLegacy(acc, mine);
            logger.info(`Eski ortak kayıtlardan ${mine.length}/${lines.length} tanesi bu hesaba aktarıldı`);
        }
        settings.store.migratedAccounts = [...new Set([...(settings.store.migratedAccounts ?? []), acc])];
    } catch (e) {
        logger.error("Eski kayıtlar aktarılamadı", e);
    }
}

async function initAccount(acc: string) {
    if (!acc || account === acc) return;
    account = acc;

    // Önceki hesabın hafızadaki verilerini temizle
    indexReady = false;
    deletedIndex.clear();
    editIndex.clear();
    ownCache.clear();
    seenAttachments.clear();

    await migrateLegacy(acc);
    if (account !== acc) return;
    await loadIndex(acc);
    flush();
    pruneNow();
}

/** Snowflake ID'den gönderilme zamanı (ms) */
function snowflakeTime(id: string) {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
}

/** Diskteki silme kaydından Discord'un beklediği ham mesaj nesnesini üretir */
function toRawMessage(rec: any) {
    const user: any = rec.authorId ? UserStore.getUser(rec.authorId) : null;
    const files = rec.attachments?.length
        ? "\n" + rec.attachments.map((a: any) => `📎 ${a.filename}`).join("\n")
        : "";

    return {
        id: rec.messageId,
        channel_id: rec.channelId,
        type: 0,
        flags: 0,
        content: (rec.content ?? "") + files,
        author: {
            id: rec.authorId ?? "0",
            username: user?.username ?? rec.authorUsername ?? "?",
            global_name: user?.globalName ?? rec.authorName ?? null,
            avatar: user?.avatar ?? rec.authorAvatar ?? null,
            discriminator: user?.discriminator ?? "0",
            bot: user?.bot ?? false,
            public_flags: user?.publicFlags ?? 0
        },
        timestamp: new Date(rec.sentAt ?? snowflakeTime(rec.messageId)).toISOString(),
        edited_timestamp: null,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_channels: [],
        mention_everyone: false,
        pinned: false,
        tts: false,
        components: [],
        reactions: []
    };
}

/**
 * Discord bir kanalın mesajlarını yüklediğinde (LOAD_MESSAGES_SUCCESS),
 * Discord işlemeden ÖNCE araya girer: o aralıkta silinmiş mesajlarımızı listeye ekler.
 */
function onLoadMessages(action: any) {
    const { channelId, messages } = action;
    if (!channelId || !Array.isArray(messages)) return;
    if (isLocationIgnored(channelId)) return; // yoksayılan yerde eski kayıtları da gösterme

    const present = new Set<string>(messages.map((m: any) => m.id));
    const toMark: { id: string; at: number; }[] = [];

    const byMsg = deletedIndex.get(channelId);
    if (byMsg?.size) {
        let lo: bigint | null = null, hi: bigint | null = null;
        for (const m of messages) {
            const v = BigInt(m.id);
            if (lo === null || v < lo) lo = v;
            if (hi === null || v > hi) hi = v;
        }
        const openBottom = action.hasMoreBefore === false;          // kanalın en başına ulaşıldı
        const openTop = !action.isBefore && !action.hasMoreAfter;   // en yeni mesajlar yüklendi

        const added: any[] = [];
        for (const rec of byMsg.values()) {
            if (present.has(rec.messageId) || isRecordHidden(rec)) continue;
            const v = BigInt(rec.messageId);
            const fits = lo === null || hi === null
                ? openBottom && openTop
                : (openBottom || v >= lo) && (openTop || v <= hi);
            if (!fits) continue;

            added.push(toRawMessage(rec));
            toMark.push({ id: rec.messageId, at: rec.at });
        }

        if (added.length) {
            messages.push(...added);
            messages.sort((a: any, b: any) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)); // yeniden eskiye
        }
    }

    const edits: { id: string; history: any[]; }[] = [];
    for (const m of messages) {
        const list = editIndex.get(m.id);
        if (list?.length && !isRecordHidden(list[0]))
            edits.push({
                id: m.id,
                history: [...list]
                    .sort((a, b) => a.at - b.at)
                    .map(r => ({ timestamp: new Date(r.at), content: r.content }))
            });
    }

    if (!toMark.length && !edits.length) return;

    // Discord mesajları hafızaya aldıktan hemen sonra işaretle
    setTimeout(() => {
        for (const { id, at } of toMark)
            updateMessage(channelId, id, { deleted: true, deletedAt: at } as any);
        for (const { id, history } of edits) {
            const cur: any = MessageStore.getMessage(channelId, id);
            if (cur && !cur.editHistory?.length)
                updateMessage(channelId, id, { editHistory: history } as any);
        }
    }, 0);
}

function interceptor(action: any) {
    try {
        if (action?.type === "LOAD_MESSAGES_SUCCESS") {
            // Görünen mesajların dosyalarını önceden indir (DM ve sunucu)
            for (const m of action.messages ?? []) precache(m);
            if (indexReady) onLoadMessages(action);
        }
    } catch (e) {
        logger.error("Geri yükleme hatası", e);
    }
    return false; // olayı engelleme, devam etsin
}

let pruneTimer: ReturnType<typeof setInterval> | undefined;

function pruneNow() {
    const logDays = Math.max(1, Number(settings.store.logDays) || 30);
    const mediaDays = Math.max(1, Number(settings.store.mediaDays) || 7);
    pruneIndex(logDays);
    if (!account) return;
    Native.prune(account, logDays, mediaDays, maxCacheBytes())
        .then(n => n && logger.info(`${n} eski kayıt/dosya silindi`))
        .catch(e => logger.error("Temizlik hatası", e));
}

// ─────────────────────────── Arka plan önbelleği ───────────────────────────
// Discord, açmadığın kanallardaki yeni mesajları da gönderir ama hafızasında tutmaz.

const ownCache = new Map<string, Snap>();

function cacheMessage(raw: any) {
    if (!raw?.id || !raw.channel_id) return;
    const s = snapshot(raw);
    if (settings.store.ignoreBots && s.bot) return;
    ownCache.delete(s.id); // sona taşı
    ownCache.set(s.id, s);
    if (ownCache.size > OWN_CACHE_MAX)
        ownCache.delete(ownCache.keys().next().value!);
}

/** Yeni ek listesinde olmayan (kaldırılmış) ekleri bulur */
function removedAttachments(oldAtts: any[] | undefined, newAtts: any[] | undefined) {
    if (!Array.isArray(newAtts) || !oldAtts?.length) return [];
    const keep = new Set(newAtts.map(a => a.id));
    return oldAtts.filter(a => !keep.has(a.id) && !a.deleted);
}

// ─────────────────────────── Logdan kaldır ───────────────────────────

function hasHistory(msg: any) {
    return !!(msg?.deleted || msg?.editHistory?.length || msg?.attachments?.some((a: any) => a.deleted));
}

/** Sadece ekrandaki görünümü temizler */
function clearUi(msg: any) {
    if (msg.deleted) {
        // Silinmiş mesaj: ekrandan tamamen kaldır (mlDeleted → handleDelete bunu gerçek silme sayar)
        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId: msg.channel_id,
            id: msg.id,
            mlDeleted: true
        });
    } else {
        const fields: any = { editHistory: [] };
        if (Array.isArray(msg.attachments) && msg.attachments.some((a: any) => a.deleted))
            fields.attachments = msg.attachments.filter((a: any) => !a.deleted);
        updateMessage(msg.channel_id, msg.id, fields);
    }
}

export async function removeFromLog(msg: any) {
    // Kuyrukta bekleyen kayıt varsa önce yaz, sonra sil (yoksa silindikten sonra geri yazılır)
    await flush();
    unindex(msg.id, msg.channel_id);
    if (!account) return;
    Native.removeRecords(account, msg.id)
        .then(n => logger.info(`${msg.id} için ${n} kayıt diskten silindi`))
        .catch(e => logger.error("Kayıt silinemedi", e));
    clearUi(msg);
}

async function clearChannelLog(channelId: string) {
    if (!confirm("Bu kanaldaki tüm silinen/düzenlenen mesaj kayıtları ve kaydedilen dosyaları kalıcı olarak silinecek.\n\nEmin misin?"))
        return;

    await flush();
    unindexChannel(channelId);
    if (!account) return;
    const n = await Native.removeChannel(account, channelId).catch(e => { logger.error("Kanal logu silinemedi", e); return 0; });

    const messages: any = MessageStore.getMessages(channelId);
    messages?.forEach?.((m: any) => { if (hasHistory(m)) clearUi(m); });

    showToast(`${n} kayıt silindi`);
}

async function clearGuildLog(guildId: string, ask: boolean) {
    if (ask && !confirm("Bu sunucudaki tüm silinen/düzenlenen mesaj kayıtları ve kaydedilen dosyaları kalıcı olarak silinecek.\n\nEmin misin?"))
        return;
    if (!account) return;

    await flush();
    unindexGuild(guildId);
    const n = await Native.removeGuild(account, guildId).catch(e => { logger.error("Sunucu logu silinemedi", e); return 0; });
    showToast(`${n} kayıt silindi`);
}

async function showSavedFiles(msg: any) {
    if (!account) return;
    const count = await Native.showMedia(account, msg.id);
    if (!count) showToast("Bu mesaj için kaydedilmiş dosya yok");
}

/** Mesajın kaydedilmiş olabilecek bir dosyası var mı? (diskten geri yüklenenlerde ek listesi kayıttan okunur) */
function hasSavedAttachments(message: any) {
    if (message.attachments?.some((a: any) => a.deleted)) return true;
    if (!message.deleted) return false;
    if (message.attachments?.length) return true;
    return !!deletedIndex.get(message.channel_id)?.get(message.id)?.attachments?.length;
}

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, { message }) => {
    if (!hasHistory(message)) return;

    if (hasSavedAttachments(message))
        children.push(
            <Menu.MenuItem
                id="liqht-show-files"
                label="Kaydedilen dosyayı göster"
                action={() => showSavedFiles(message)}
            />
        );

    children.push(
        <Menu.MenuItem
            id="liqht-remove-log"
            label="Logdan kaldır"
            color="danger"
            action={() => removeFromLog(message)}
        />
    );
};

/** Kanal / thread / grup DM / kullanıcı (DM) sağ tık menüsü */
const patchChannelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const user = props?.user;
    const channel = props?.channel;
    const channelId: string | undefined =
        channel?.id ?? (user?.id ? ChannelStore.getDMFromUserId(user.id) : undefined);

    // Kullanıcıyı yoksay (kendin hariç)
    if (user?.id && user.id !== myId()) {
        const ignored = idList(settings.store.ignoreUsers).includes(user.id);
        children.push(
            <Menu.MenuItem
                id="liqht-ignore-user"
                label={ignored ? "LiqhtLogger: Kullanıcıyı yoksaymayı kaldır" : "LiqhtLogger: Bu kullanıcıyı yoksay"}
                action={() => {
                    toggleId("ignoreUsers", user.id);
                    showToast(ignored ? `${user.username} tekrar kaydedilecek` : `${user.username} artık kaydedilmeyecek`);
                }}
            />
        );
    }

    // Sunucu kanalını / thread'i yoksay (DM'ler için "Kaydedilecek Alanlar" ayarı kullanılır)
    if (channel?.id && channel.guild_id && !user) {
        const ignored = idList(settings.store.ignoreChannels).includes(channel.id);
        children.push(
            <Menu.MenuItem
                id="liqht-ignore-channel"
                label={ignored ? "LiqhtLogger: Kanalı yoksaymayı kaldır" : "LiqhtLogger: Bu kanalı yoksay"}
                action={() => {
                    toggleId("ignoreChannels", channel.id);
                    showToast(ignored ? `#${channel.name} tekrar kaydedilecek` : `#${channel.name} artık kaydedilmeyecek`);
                }}
            />
        );
    }

    if (channelId && channelHasLogs(channelId))
        children.push(
            <Menu.MenuItem
                id="liqht-clear-channel"
                label="Bu kanalın logunu temizle"
                color="danger"
                action={() => clearChannelLog(channelId)}
            />
        );
};

/** Sunucu sağ tık menüsü */
const patchGuildContextMenu: NavContextMenuPatchCallback = (children, { guild }) => {
    if (!guild?.id) return;
    const logged = isGuildLogged(guild.id);
    children.push(
        <Menu.MenuItem
            id="liqht-toggle-guild"
            label={logged ? "LiqhtLogger: Bu sunucuyu kaydetme" : "LiqhtLogger: Bu sunucuyu kaydet"}
            action={() => {
                setGuildLogged(guild.id, !logged);
                showToast(logged ? `${guild.name} artık kaydedilmeyecek` : `${guild.name} kaydedilecek`);
                if (logged && guildHasLogs(guild.id)
                    && confirm(`${guild.name} sunucusunun şimdiye kadar kaydedilmiş mesajları ve dosyaları da silinsin mi?`))
                    clearGuildLog(guild.id, false);
            }}
        />
    );

    if (guildHasLogs(guild.id))
        children.push(
            <Menu.MenuItem
                id="liqht-clear-guild"
                label="LiqhtLogger: Bu sunucunun logunu temizle"
                color="danger"
                action={() => clearGuildLog(guild.id, true)}
            />
        );
};

// ─────────────────────────── Gelen Kutusu yanındaki buton ───────────────────────────
// Discord'un kodunu patch'lemek yerine, Gelen Kutusu butonunu sayfada bulup hemen soluna
// kendi butonumuzu koyuyoruz. Discord üst çubuğu yeniden çizerse tekrar ekleniyor.

const BTN_ID = "liqht-toolbar-btn";
const INBOX_SELECTORS = ['[aria-label="Inbox"]', '[aria-label="Gelen Kutusu"]'];
const ICON_SVG =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-.7 10.1A2 2 0 0 1 15.3 21H8.7a2 2 0 0 1-2-1.9L6 9Zm6 2a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm-.6 1.6h1.2v1.8l1.3 1.3-.8.8-1.7-1.6v-2.3Z"/>' +
    "</svg>";

let observer: MutationObserver | undefined;
let scheduled = false;

function findInbox(): HTMLElement | null {
    for (const sel of INBOX_SELECTORS) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) return el;
    }
    return null;
}

function ensureToolbarButton() {
    scheduled = false;
    const existing = document.getElementById(BTN_ID);

    if (!settings.store.toolbarButton) {
        existing?.remove();
        return;
    }

    const inbox = findInbox();
    if (!inbox?.parentElement) return;
    if (existing && existing.nextElementSibling === inbox) return;
    existing?.remove();

    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.className = typeof inbox.className === "string" ? inbox.className : inbox.getAttribute("class") ?? "";
    btn.classList.add("liqht-toolbar-btn");
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "LiqhtLogger");
    btn.title = "LiqhtLogger — silinen ve düzenlenen mesajlar";
    btn.tabIndex = 0;
    btn.innerHTML = ICON_SVG;
    btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
    });
    inbox.parentElement.insertBefore(btn, inbox);
}

function startToolbarObserver() {
    observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(ensureToolbarButton);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    ensureToolbarButton();
}

function stopToolbarObserver() {
    observer?.disconnect();
    observer = undefined;
    document.getElementById(BTN_ID)?.remove();
}

// ─────────────────────────── Plugin ───────────────────────────

export default definePlugin({
    name: "LiqhtLogger",
    description: "Silinen ve düzenlenen mesajları diske kaydeder, kanalda gösterir.",
    authors: [{ name: "Liqht", id: 0n }],
    dependencies: ["MessageUpdaterAPI"],
    settings,

    contextMenus: {
        "message": patchMessageContextMenu,
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu,
        "user-context": patchChannelContextMenu,
        "guild-context": patchGuildContextMenu
    },

    toolboxActions: {
        "Silinen mesajlar paneli": () => openPanel()
    },

    start() {
        // Önceki sürümdeki iki açma/kapama ayarını yeni bölüme taşı (bir kez)
        const s: any = settings.store;
        if (!s.migrated) {
            if (typeof s.predownloadDMs === "boolean") s.dmAll = s.predownloadDMs;
            if (typeof s.predownloadGuilds === "boolean") s.guildsEnabled = s.predownloadGuilds;
            s.migrated = true;
        }

        (FluxDispatcher as any).addInterceptor(interceptor);
        const me = myId();
        if (me) initAccount(me); // değilse CONNECTION_OPEN'da başlar
        pruneTimer = setInterval(pruneNow, 60 * 60 * 1000); // saatte bir
        startToolbarObserver();
    },

    stop() {
        const list = (FluxDispatcher as any)._interceptors as any[] | undefined;
        const i = list?.indexOf(interceptor) ?? -1;
        if (i !== -1) list!.splice(i, 1);

        clearInterval(pruneTimer);
        stopToolbarObserver();
        flush();
    },

    flux: {
        CONNECTION_OPEN({ user }: any) {
            if (user?.id) initAccount(user.id);
        },

        MESSAGE_CREATE({ message, optimistic, channelId, guildId }: any) {
            if (optimistic) return;
            cacheMessage(message);
            if (message?.attachments?.length && shouldPrecache(channelId ?? message.channel_id, guildId ?? message.guild_id))
                precache(message);
        },

        // Hafızada olmayan (açılmamış kanal) mesajların düzenlemeleri ve kaldırılan ekleri.
        // Hafızadakiler MessageStore patch'i ile handleEdit'te yakalanıyor.
        MESSAGE_UPDATE({ message }: any) {
            const old = message?.id && ownCache.get(message.id);
            if (!old) return;

            const inStore = MessageStore.getMessage(message.channel_id, message.id);

            const removed = removedAttachments(old.attachments, message.attachments);
            if (removed.length) {
                if (!inStore && !isIgnored(old, false))
                    writeRecord("attachment", { ...old, attachments: removed }, Date.now(), { source: "cache" });
                old.attachments = old.attachments.filter(a => !removed.includes(a));
            }

            if (message.content === undefined) return;
            if (!inStore && message.edited_timestamp && message.content !== old.content && !isIgnored(old, true))
                writeRecord("edit", old, Date.now(), { newContent: message.content, source: "cache" });

            old.content = message.content;
        }
    },

    /** MessageStore'daki MESSAGE_DELETE / MESSAGE_DELETE_BULK işleyicisinin yerine çalışır */
    handleDelete(cache: any, data: { ids?: string[]; id?: string; channelId: string; mlDeleted?: boolean; }, isBulk: boolean) {
        try {
            if (cache == null) return cache;
            const ids = (isBulk ? data.ids : [data.id]) ?? [];

            for (const id of ids) {
                if (!id) continue;
                const msg = cache.get(id);

                // 1) Discord'un hafızasında yok → kendi önbelleğimize bak
                if (!msg) {
                    const s = ownCache.get(id);
                    if (s && !data.mlDeleted && !isIgnored(s, false))
                        writeRecord("delete", s, Date.now(), { bulk: isBulk, source: "cache" });
                    ownCache.delete(id);
                    continue;
                }

                // 2) Hafızada var
                const s = snapshot(msg);
                const ignore = data.mlDeleted
                    || (s.flags & EPHEMERAL) === EPHEMERAL
                    || isIgnored(s, false);

                if (ignore) {
                    cache = cache.remove(id); // normal davran: gerçekten sil
                } else if (!msg.deleted) {
                    const now = Date.now();
                    writeRecord("delete", s, now, { bulk: isBulk, source: "store" });
                    cache = cache.update(id, (m: any) => m
                        .set("deleted", true)
                        .set("deletedAt", now)
                        .set("attachments", m.attachments.map((a: any) => (a.deleted = true, a))));
                }
                ownCache.delete(id);
            }
        } catch (e) {
            logger.error("handleDelete hatası", e);
        }
        return cache;
    },

    /** MessageStore'daki MESSAGE_UPDATE içinde, mesaj güncellenmeden hemen önce çalışır */
    handleEdit(newMsg: any, m: any) {
        try {
            if ((newMsg.flags & EPHEMERAL) === EPHEMERAL) return m;
            const s = snapshot(m);

            // Mesaj silinmeden sadece eki kaldırıldıysa
            const removed = removedAttachments(m.attachments, newMsg.attachments);
            if (removed.length && !isIgnored(s, false)) {
                const removedIds = new Set(removed.map((a: any) => a.id));
                writeRecord("attachment", { ...s, attachments: s.attachments.filter(a => removedIds.has(a.id)) }, Date.now(), { source: "store" });
            }

            if (!newMsg.edited_timestamp || newMsg.content === undefined || newMsg.content === m.content) return m;
            if (isIgnored(s, true)) return m;

            writeRecord("edit", s, Date.now(), { newContent: newMsg.content, source: "store" });
            const cached = ownCache.get(m.id);
            if (cached) cached.content = newMsg.content;

            return m.set("editHistory", [
                ...(m.editHistory || []),
                { timestamp: new Date(newMsg.edited_timestamp), content: m.content }
            ]);
        } catch (e) {
            logger.error("handleEdit hatası", e);
            return m;
        }
    },

    /** Düzenlemeden sonra ek listesi: kaldırılan ekleri "silinmiş" olarak tut (gri görünür) */
    handleUpdateAttachments(newMessage: any) {
        try {
            const oldMessage: any = MessageStore.getMessage(newMessage.channel_id, newMessage.id);
            if (!oldMessage || !Array.isArray(newMessage.attachments) || !settings.store.logDeletes)
                return newMessage.attachments ?? [];

            return oldMessage.attachments
                .map((o: any) => newMessage.attachments.find((a: any) => a.id === o.id) ?? { ...o, deleted: true })
                .concat(newMessage.attachments.filter((a: any) => !oldMessage.attachments.some((o: any) => o.id === a.id)));
        } catch (e) {
            logger.error("handleUpdateAttachments hatası", e);
            return newMessage.attachments ?? [];
        }
    },

    /** Silinmiş mesajın <li> elemanına data-liqht-deleted olarak yazılır, CSS ::after ile gösterilir */
    deletedLabel(msg: any) {
        return msg.deletedAt ? `Silindi · ${fmt(msg.deletedAt)}` : "Silindi";
    },

    /** Mesaj içeriğinin üstüne: eski düzenlemeler */
    renderExtras: ErrorBoundary.wrap(({ message: { id, channel_id } }: { message: any; }) => {
        const message = useStateFromStores(
            [MessageStore],
            () => MessageStore.getMessage(channel_id, id) as any,
            null,
            (a: any, b: any) => a?.editHistory === b?.editHistory
        );
        if (!message) return null;

        return (
            <>
                {settings.store.inlineEdits && message.editHistory?.map((edit: any, i: number) => (
                    <div key={i} className="liqht-edited">
                        {parseContent(edit.content, message)}
                        <span className="liqht-edited-time"> ({fmt(edit.timestamp)} tarihinde değiştirildi)</span>
                    </div>
                ))}
            </>
        );
    }, { noop: true }),

    // Aynı nonce ile mesajı "yerinde değiştirme" açığını kapatır (orijinal MessageLogger'dan)
    normalizeNonce(msg: any) {
        try {
            if (!msg.nonce || msg.author.id === AuthenticationStore.getId()) return;
            const prevMsg = MessageStore.getMessage(msg.channel_id, msg.nonce);
            if (!prevMsg || prevMsg.state !== "SENT") return;
            if (prevMsg.id !== msg.id) delete msg.nonce;
        } catch (e) {
            logger.error("normalizeNonce hatası", e);
        }
    },

    commands: [
        {
            name: "llklasor",
            description: "LiqhtLogger kayıt klasörünü açar",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async () => {
                await flush();
                if (account) await Native.openFolder(account);
            }
        },
        {
            name: "llpanel",
            description: "LiqhtLogger panelini açar",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => { openPanel(); }
        }
    ],

    patches: [
        {
            find: '"MessageStore"',
            replacement: [
                {
                    // Silinen mesajı silme, işaretle + diske yaz
                    match: /(?<=MESSAGE_DELETE:function\((\i)\)\{)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: "let cache=$2.getOrCreate($1.channelId);cache=$self.handleDelete(cache,$1,false);$2.commit(cache);return;"
                },
                {
                    // Toplu silme (purge)
                    match: /(?<=MESSAGE_DELETE_BULK:function\((\i)\)\{)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: "let cache=$2.getOrCreate($1.channelId);cache=$self.handleDelete(cache,$1,true);$2.commit(cache);return;"
                },
                {
                    // Düzenlemeden önce eski hali editHistory'ye ekle + diske yaz
                    match: /(MESSAGE_UPDATE:function\((\i)\).+?)\.update\((\i)/,
                    replace: "$1.update($3,m=>$self.handleEdit($2.message,m)).update($3"
                },
                {
                    // Yukarı ok ile silinmiş mesajı düzenlemeye çalışmasın
                    match: /(?<=getLastEditableMessage\(\i\)\{.{0,200}\.find\((\i)=>)/,
                    replace: "!$1.deleted&&"
                }
            ]
        },
        {
            // Mesaj modeli: yeni alanlarımızı taşı
            find: "}addReaction(",
            replacement: {
                match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                replace: "$&this.deleted=$1.deleted||false,this.deletedAt=$1.deletedAt||null,this.editHistory=$1.editHistory||[],this.firstEditTimestamp=$1.firstEditTimestamp||this.editedTimestamp||this.timestamp,"
            }
        },
        {
            // Düzenlenen mesaj yeniden oluşturulurken alanlarımız ve kaldırılan ekler kaybolmasın
            find: ".PREMIUM_REFERRAL&&(",
            replacement: [
                {
                    match: /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:(\i)\.reactions.{0,50}\}\)/,
                    replace: "Object.assign($&,{deleted:$1.deleted,deletedAt:$1.deletedAt,editHistory:$1.editHistory,firstEditTimestamp:$1.firstEditTimestamp})"
                },
                {
                    match: /attachments:(\i)\.attachments\?\?\[\],/,
                    replace: "attachments:$self.handleUpdateAttachments($1),"
                }
            ]
        },
        {
            // Ek gösterici: kaldırılmış eklere gri sınıf ver, silinmiş mesajın eklerini kaldırılamaz yap
            find: "#{intl::REMOVE_ATTACHMENT_TOOLTIP_TEXT}",
            replacement: [
                {
                    match: /\.SPOILER,(?=\[\i\.\i\]:)(?<=item:(\i),.{0,200}?)/,
                    replace: '$&"liqht-deleted-attachment":$1?.originalItem?.deleted,'
                },
                {
                    match: /(?<=\{let\{[^}]*?item:(\i),autoPlayGif:\i,)canRemoveItem:(\i)(?=,onRemoveItem:)/,
                    replace: "_canRemoveItem:$2=arguments[0].canRemoveItem&&!$1?.originalItem?.deleted"
                }
            ]
        },
        {
            // Silinmiş mesajın <li> elemanına sınıf (kırmızı görünüm) ve silinme saati ekle
            find: "Message must not be a thread starter message",
            replacement: {
                match: /\)\("li",\{(.+?),className:/,
                replace: ")(\"li\",{$1,\"data-liqht-deleted\":arguments[0].message.deleted?$self.deletedLabel(arguments[0].message):void 0,className:(arguments[0].message.deleted?\"liqht-deleted \":\"\")+"
            }
        },
        {
            // Mesaj içeriğinin başına eski düzenlemeleri ekle
            find: ".SEND_FAILED,",
            replacement: {
                match: /\]:\i.isUnsupported.{0,20}?,children:\[/,
                replace: "$&arguments[0]?.message?.editHistory?.length>0&&$self.renderExtras(arguments[0]),"
            }
        },
        {
            // Yanıtlanan mesaj silinince alıntı kaybolmasın
            find: '"ReferencedMessageStore"',
            replacement: [
                {
                    match: /(?<=MESSAGE_DELETE:function\(\i\)\{)/,
                    replace: "return;"
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\(\i\)\{)/,
                    replace: "return;"
                }
            ]
        },
        {
            // Silinmiş mesajın sağ tık menüsünde Yanıtla/Düzenle vb. gösterme
            find: ".MESSAGE,commandTargetId:",
            replacement: {
                match: /children:(\[""===.+?\])/,
                replace: "children:arguments[0].message.deleted?[]:$1"
            }
        },
        {
            find: "this.truncateTop",
            replacement: {
                match: /receiveMessage\((\i)\)\{/,
                replace: "$& $self.normalizeNonce($1);"
            }
        }
    ]
});
