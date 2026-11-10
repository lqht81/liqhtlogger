/*
 * LiqhtLogger — Vencord userplugin
 * Bu dosya Discord'un ana sürecinde (Node.js) çalışır, diske yazabilen tek kısım burası.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";
import { app, shell } from "electron";
import { existsSync, mkdirSync } from "fs";
import { appendFile, copyFile, open, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";

// %APPDATA%\Vencord\LiqhtLogger\accounts\<hesapId>\...
// Her Discord hesabının kayıtları ayrı klasörde tutulur. Aynı hesap iki Discord'da açıksa
// aynı klasörü kullanır (çift kayıt claims ile önlenir).
const ROOT = join(app.getPath("appData"), "Vencord", "LiqhtLogger");
const ACCOUNTS = join(ROOT, "accounts");
const LEGACY_LOGS = join(ROOT, "logs");   // hesaplara ayrılmadan önceki ortak kayıtlar
const LEGACY_MEDIA = join(ROOT, "media");

const CACHE_HOURS = 24;                   // önbellekteki dosya silinmezse kaç saat sonra atılsın
const CLAIM_HOURS = 6;                    // işaret dosyaları kaç saat tutulsun
const MAX_READ_BYTES = 300 * 1024 * 1024; // panelde açılabilecek en büyük dosya

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d+$/;
const KEY_RE = /^[\w-]{1,120}$/;
// Sadece Discord'un kendi dosya sunucularından indir
const URL_RE = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;

interface Dirs { base: string; logs: string; media: string; cache: string; claims: string; }

/** Hesabın klasörlerini döndürür (yoksa oluşturur) */
function dirs(account: string): Dirs {
    if (!ID_RE.test(String(account))) throw new Error("Geçersiz hesap");
    const base = join(ACCOUNTS, account);
    const d = {
        base,
        logs: join(base, "logs"),          // günlük .jsonl dosyaları
        media: join(base, "media"),        // silinen mesajların dosyaları: media\<gün>\...
        cache: join(base, "media", "_cache"), // önceden indirilen, henüz silinmemiş dosyalar
        claims: join(base, "claims")       // aynı hesap iki Discord'da açıkken çift kaydı önler
    };
    for (const dir of Object.values(d))
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return d;
}

function dayStr(d: Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Yolun gerçekten LiqhtLogger klasörünün içinde olduğunu doğrular */
function insideRoot(path: string) {
    const p = resolve(String(path));
    return p.startsWith(resolve(ROOT) + sep) ? p : null;
}

// ─────────────────────────── Çift kayıt önleme ───────────────────────────
// Aynı anahtar için sadece ilk gelen "kazanır": dosya "wx" (yoksa oluştur) ile açılır,
// ikinci Discord aynı dosyayı oluşturamaz.

async function tryClaim(d: Dirs, key: string) {
    if (!KEY_RE.test(key)) return true;
    try {
        const fh = await open(join(d.claims, key), "wx");
        await fh.close();
        return true;
    } catch {
        return false;
    }
}

export async function claim(_: IpcMainInvokeEvent, account: string, key: string) {
    return tryClaim(dirs(account), key);
}

// ─────────────────────────── Kayıtlar ───────────────────────────

/** Verilen günün dosyasına satırları ekler. Aynı hesabın diğer Discord'unun yazdıkları atlanır. */
export async function appendRecords(_: IpcMainInvokeEvent, account: string, day: string, lines: string[]) {
    if (!DAY_RE.test(day) || !Array.isArray(lines) || !lines.length) return;
    const d = dirs(account);

    const keep: string[] = [];
    for (const line of lines) {
        let key: string | undefined;
        try { key = JSON.parse(line).k; } catch { continue; }
        if (!key || await tryClaim(d, "r_" + key)) keep.push(line);
    }
    if (keep.length)
        await appendFile(join(d.logs, `${day}.jsonl`), keep.join("\n") + "\n", "utf8");
}

async function readLogDir(dir: string, sinceDay: string) {
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir))
        .filter(f => f.endsWith(".jsonl") && f.slice(0, 10) >= sinceDay)
        .sort();

    const lines: string[] = [];
    for (const f of files) {
        const text = await readFile(join(dir, f), "utf8");
        for (const line of text.split("\n"))
            if (line.trim()) lines.push(line);
    }
    return lines;
}

/** sinceDay (dahil) tarihinden itibaren hesabın tüm kayıt satırlarını döndürür */
export async function readRecords(_: IpcMainInvokeEvent, account: string, sinceDay: string) {
    return readLogDir(dirs(account).logs, sinceDay);
}

/** Satırlardan filtreye uyanları siler, silinen mesaj ID'lerini döndürür */
async function removeLines(d: Dirs, match: (line: string) => boolean) {
    const removedIds = new Set<string>();
    let removed = 0;

    for (const f of await readdir(d.logs)) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(d.logs, f);
        const lines = (await readFile(path, "utf8")).split("\n").filter(l => l.trim());
        const kept: string[] = [];
        for (const l of lines) {
            if (match(l)) {
                removed++;
                const id = /"messageId":"(\d+)"/.exec(l)?.[1];
                if (id) removedIds.add(id);
            } else kept.push(l);
        }
        if (kept.length === lines.length) continue;

        if (kept.length) await writeFile(path, kept.join("\n") + "\n", "utf8");
        else await rm(path, { force: true });
    }
    return { removed, removedIds };
}

/** Verilen mesajlara ait indirilmiş dosyaları (media\<gün> ve _cache) siler */
async function removeMediaFor(d: Dirs, ids: Set<string>) {
    if (!ids.size) return;
    for (const sub of await readdir(d.media)) {
        const dir = join(d.media, sub);
        let files: string[];
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
            const id = f.split("_", 1)[0];
            if (ids.has(id)) await rm(join(dir, f), { force: true });
        }
    }
}

/** Bir mesaja ait tüm kayıtları ve dosyalarını siler */
export async function removeRecords(_: IpcMainInvokeEvent, account: string, messageId: string) {
    if (!ID_RE.test(messageId)) return 0;
    const d = dirs(account);
    const needle = `"messageId":"${messageId}"`;
    const { removed } = await removeLines(d, l => l.includes(needle));
    await removeMediaFor(d, new Set([messageId]));
    return removed;
}

/** Bir kanala ait tüm kayıtları ve dosyalarını siler */
export async function removeChannel(_: IpcMainInvokeEvent, account: string, channelId: string) {
    if (!ID_RE.test(channelId)) return 0;
    const d = dirs(account);
    const needle = `"channelId":"${channelId}"`;
    const { removed, removedIds } = await removeLines(d, l => l.includes(needle));
    await removeMediaFor(d, removedIds);
    return removed;
}

/** Bir sunucuya ait tüm kayıtları ve dosyalarını siler */
export async function removeGuild(_: IpcMainInvokeEvent, account: string, guildId: string) {
    if (!ID_RE.test(guildId)) return 0;
    const d = dirs(account);
    const needle = `"guildId":"${guildId}"`;
    const { removed, removedIds } = await removeLines(d, l => l.includes(needle));
    await removeMediaFor(d, removedIds);
    return removed;
}

// ─────────────────────────── Eski ortak kayıtları hesaba aktarma ───────────────────────────
// Hesaplara ayırmadan önce tüm kayıtlar tek klasördeydi. Her hesap ilk açılışta
// eski kayıtlardan kendi görebildiği kanallara ait olanları kendi klasörüne kopyalar.

export async function readLegacy(_: IpcMainInvokeEvent) {
    return readLogDir(LEGACY_LOGS, "0000-00-00");
}

/** Satırları "at" alanına göre günlere ayırıp hesabın klasörüne yazar, eklerini de kopyalar */
export async function importLegacy(_: IpcMainInvokeEvent, account: string, lines: string[]) {
    const d = dirs(account);
    const byDay: Record<string, string[]> = {};
    const ids = new Set<string>();

    for (const line of lines) {
        try {
            const rec = JSON.parse(line);
            const day = dayStr(new Date(rec.at));
            if (!DAY_RE.test(day)) continue;
            (byDay[day] ??= []).push(line);
            if (rec.messageId) ids.add(String(rec.messageId));
        } catch { /* bozuk satır */ }
    }
    for (const [day, list] of Object.entries(byDay))
        await appendFile(join(d.logs, `${day}.jsonl`), list.join("\n") + "\n", "utf8");

    // Eklerin kopyası (silinmiş mesajlarınkiler, _cache hariç)
    if (existsSync(LEGACY_MEDIA)) {
        for (const day of await readdir(LEGACY_MEDIA)) {
            if (!DAY_RE.test(day)) continue;
            let files: string[];
            try { files = await readdir(join(LEGACY_MEDIA, day)); } catch { continue; }
            for (const f of files) {
                if (!ids.has(f.split("_", 1)[0])) continue;
                const dest = join(d.media, day);
                if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
                if (!existsSync(join(dest, f))) await copyFile(join(LEGACY_MEDIA, day, f), join(dest, f));
            }
        }
    }
    return lines.length;
}

// ─────────────────────────── Dosya indirme ───────────────────────────

/** Windows'ta geçersiz karakterleri temizler */
function safeName(name: string) {
    const clean = String(name || "dosya").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    return clean.slice(-100) || "dosya";
}

function mediaName(messageId: string, attachmentId: string, filename: string) {
    return `${messageId}_${attachmentId}_${safeName(filename)}`;
}

/** Linkleri sırayla dener, ilk başarılı olanı dest'e yazar. Yazılan bayt sayısını döndürür (0 = başarısız). */
async function download(urls: string[], dest: string, maxBytes: number) {
    for (const url of urls) {
        if (typeof url !== "string" || !URL_RE.test(url)) continue;
        try {
            const res = await fetch(url);
            if (!res.ok) continue;

            const len = Number(res.headers.get("content-length") || 0);
            if (len && len > maxBytes) return 0;

            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > maxBytes) return 0;

            await writeFile(dest, buf);
            return buf.length;
        } catch {
            // sonraki linki dene
        }
    }
    return 0;
}

// Hesap başına önbellek boyutu takibi
const cacheBytes = new Map<string, number>();

/** _cache toplamı sınırı aşarsa en eski dosyalardan başlayarak %90'ın altına iner */
async function enforceCache(account: string, d: Dirs, maxCacheBytes: number) {
    const list: { path: string; size: number; mtime: number; }[] = [];
    let total = 0;
    for (const f of await readdir(d.cache)) {
        const path = join(d.cache, f);
        try {
            const st = await stat(path);
            total += st.size;
            list.push({ path, size: st.size, mtime: st.mtimeMs });
        } catch { /* yoksay */ }
    }

    if (total > maxCacheBytes) {
        list.sort((a, b) => a.mtime - b.mtime);
        for (const f of list) {
            if (total <= maxCacheBytes * 0.9) break;
            await rm(f.path, { force: true });
            total -= f.size;
        }
    }
    cacheBytes.set(account, total);
}

/** Mesaj henüz silinmeden dosyayı önbelleğe indirir */
export async function cacheAttachment(_: IpcMainInvokeEvent, account: string, messageId: string, attachmentId: string, filename: string, urls: string[], maxBytes: number, maxCacheBytes: number) {
    if (!ID_RE.test(messageId) || !ID_RE.test(attachmentId)) return false;
    const d = dirs(account);
    const dest = join(d.cache, mediaName(messageId, attachmentId, filename));
    if (existsSync(dest)) return true;

    const size = await download(urls, dest, maxBytes);
    if (!size) return false;

    const current = cacheBytes.get(account);
    if (current === undefined) await enforceCache(account, d, maxCacheBytes);
    else {
        cacheBytes.set(account, current + size);
        if (current + size > maxCacheBytes) await enforceCache(account, d, maxCacheBytes);
    }
    return true;
}

/** Mesaj silindiğinde: önbellekte varsa media\<gün>'e taşır, yoksa indirmeyi dener */
export async function saveAttachment(_: IpcMainInvokeEvent, account: string, messageId: string, attachmentId: string, filename: string, urls: string[], maxBytes: number, day: string) {
    if (!ID_RE.test(messageId) || !ID_RE.test(attachmentId) || !DAY_RE.test(day)) return false;
    const d = dirs(account);

    const dir = join(d.media, day);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const name = mediaName(messageId, attachmentId, filename);
    const dest = join(dir, name);
    if (existsSync(dest)) return true;

    const cached = join(d.cache, name);
    if (existsSync(cached)) {
        try {
            await rename(cached, dest);
            return true;
        } catch {
            // Diğer Discord aynı anda taşımış olabilir
            if (existsSync(dest)) return true;
        }
    }
    return (await download(urls, dest, maxBytes)) > 0;
}

/** mesajId → kaydedilmiş dosya yolları (sadece silinmiş mesajlarınkiler, _cache hariç) */
export async function listMedia(_: IpcMainInvokeEvent, account: string) {
    const d = dirs(account);
    const map: Record<string, string[]> = {};
    for (const day of await readdir(d.media)) {
        if (!DAY_RE.test(day)) continue;
        let files: string[];
        try { files = await readdir(join(d.media, day)); } catch { continue; }
        for (const f of files) {
            const id = f.split("_", 1)[0];
            (map[id] ??= []).push(join(d.media, day, f));
        }
    }
    return map;
}

/** Mesajın kaydedilmiş ilk dosyasını Dosya Gezgini'nde seçili gösterir */
export async function showMedia(_: IpcMainInvokeEvent, account: string, messageId: string) {
    if (!ID_RE.test(messageId)) return 0;
    const files = (await listMedia(_, account))[messageId] ?? [];
    if (files.length) shell.showItemInFolder(files[0]);
    return files.length;
}

/** Panelde göstermek için dosyanın içeriğini döndürür */
export async function readMedia(_: IpcMainInvokeEvent, path: string) {
    const p = insideRoot(path);
    if (!p || !existsSync(p)) return null;
    if ((await stat(p)).size > MAX_READ_BYTES) return null;
    return readFile(p);
}

/** Dosyayı Dosya Gezgini'nde seçili gösterir */
export async function showFile(_: IpcMainInvokeEvent, path: string) {
    const p = insideRoot(path);
    if (p && existsSync(p)) shell.showItemInFolder(p);
}

// ─────────────────────────── Temizlik ───────────────────────────

async function pruneDirs(logs: string, media: string, logCutoff: string, mediaCutoff: string) {
    let removed = 0;
    if (existsSync(logs))
        for (const f of await readdir(logs)) {
            const day = f.slice(0, 10);
            if (f.endsWith(".jsonl") && DAY_RE.test(day) && day < logCutoff) {
                await rm(join(logs, f), { force: true });
                removed++;
            }
        }
    if (existsSync(media))
        for (const day of await readdir(media)) {
            if (DAY_RE.test(day) && day < mediaCutoff) {
                await rm(join(media, day), { recursive: true, force: true });
                removed++;
            }
        }
    return removed;
}

async function removeOlderThan(dir: string, hours: number) {
    if (!existsSync(dir)) return 0;
    const limit = Date.now() - hours * 3_600_000;
    let removed = 0;
    for (const f of await readdir(dir)) {
        const path = join(dir, f);
        try {
            const st = await stat(path);
            if (st.isFile() && st.mtimeMs < limit) {
                await rm(path, { force: true });
                removed++;
            }
        } catch { /* yoksay */ }
    }
    return removed;
}

/** Süresi dolan kayıtları, dosyaları, önbelleği ve işaretleri siler (eski ortak klasör dahil) */
export async function prune(_: IpcMainInvokeEvent, account: string, logDays: number, mediaDays: number, maxCacheBytes: number) {
    const d = dirs(account);
    const cutoff = (days: number) => dayStr(new Date(Date.now() - days * 86_400_000));
    const logCutoff = cutoff(logDays);
    const mediaCutoff = cutoff(mediaDays);

    let removed = await pruneDirs(d.logs, d.media, logCutoff, mediaCutoff);
    removed += await removeOlderThan(d.cache, CACHE_HOURS);
    removed += await removeOlderThan(d.claims, CLAIM_HOURS);

    // Eski ortak klasör de aynı sürelerle kendiliğinden temizlenir
    removed += await pruneDirs(LEGACY_LOGS, LEGACY_MEDIA, logCutoff, mediaCutoff);
    removed += await removeOlderThan(join(LEGACY_MEDIA, "_cache"), CACHE_HOURS);
    removed += await removeOlderThan(join(ROOT, "claims"), CLAIM_HOURS);

    if (maxCacheBytes > 0) await enforceCache(account, d, maxCacheBytes);
    return removed;
}

/** Hesabın kayıt klasörünü Dosya Gezgini'nde açar */
export async function openFolder(_: IpcMainInvokeEvent, account: string) {
    return shell.openPath(dirs(account).base);
}
