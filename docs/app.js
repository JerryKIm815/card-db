/* 카드DB 휴대폰 앱 — 로컬 데이터베이스(IndexedDB) 버전
 * 데이터는 모두 이 기기 안에 저장됩니다. (서버 없음)
 */
"use strict";
const APP_VERSION = "1.5.0";
const DEFAULT_GRADES = "SEC, UR, SAR, SSR, CHR, CSR, HR, AR, SR, RRR, RR, R, UC, U, C, PR, P, L, SP, ST";
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i, ZIP_RE = /\.zip$/i, TXT_RE = /\.(txt|tsv|csv)$/i;
const IS_ANDROID_APP = !!window.CardApp;
const IOS_BRIDGE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cardApp;
const IS_IOS_APP = !!IOS_BRIDGE;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nowStr = () => new Date().toLocaleString("sv-SE").slice(0, 19);

/* ======================= 로컬 데이터베이스 ======================= */
let idb;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("carddb", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("cards")) {
        const c = d.createObjectStore("cards", { keyPath: "id", autoIncrement: true });
        c.createIndex("sha256", "sha256", { unique: true });
      }
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");      // id → {img: Blob, thumb: Blob}
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings"); // key → value
      if (!d.objectStoreNames.contains("info")) d.createObjectStore("info", { keyPath: "key" });  // 카드 정보 (번호별)
      if (!d.objectStoreNames.contains("qr")) d.createObjectStore("qr");            // id → Blob (QR 사진)
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("다른 창에서 앱이 열려 있습니다. 다른 창을 닫고 다시 여세요."));
  });
}
function tx(stores, mode = "readonly") { return idb.transaction(stores, mode); }
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("저장 실패 (저장 공간 부족일 수 있음)")); });
async function getSetting(k, def) { const v = await reqP(tx("settings").objectStore("settings").get(k)); return v === undefined ? def : v; }
async function setSetting(k, v) { const t = tx("settings", "readwrite"); t.objectStore("settings").put(v, k); await txDone(t); }
async function getFile(id) { return reqP(tx("files").objectStore("files").get(id)); }
async function getQr(id) { return reqP(tx("qr").objectStore("qr").get(id)); }
async function putCards(list) { const t = tx("cards", "readwrite"), s = t.objectStore("cards"); list.forEach(c => s.put(c)); await txDone(t); }

/* ======================= 파일명 분석 ======================= */
let gradeList = [];
const RE_KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/, RE_HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/, RE_KANJI = /[一-鿿]/;
const RE_SETNUM = /(^|[^A-Za-z0-9])([A-Za-z0-9]{1,8})\s*[-－‐]\s*([A-Za-z]{0,3}\d{1,4}[A-Za-z]?)(?![A-Za-z0-9])/;
const RE_NUM = /(^|[^0-9])(?:No\.?|#|第)?\s*(\d{2,4})(?![0-9])/i;
const RE_SPLIT = /[\s_\-\[\]\(\)【】「」『』（）〔〕《》<>{}.,·・／]+/;
function detectLang(s) {
  if (RE_KANA.test(s)) return "일본어";
  if (RE_HANGUL.test(s)) return "한국어";
  if (RE_KANJI.test(s)) return "일본어";
  return "기타";
}
function langFromFolder(path) {
  const parts = (path || "").normalize("NFC").split(/[\\/]/).slice(0, -1).reverse();
  for (const p of parts) {
    if (/일본|日本|jpn|japan|(^|[^a-z])jp([^a-z]|$)|일본어/i.test(p)) return "일본어";
    if (/한국|한글|국내|kor|(^|[^a-z])kr([^a-z]|$)|한국어/i.test(p)) return "한국어";
  }
  return "기타";
}
function sortKey(no) { return no ? no.toUpperCase().replace(/\d+/g, m => m.padStart(6, "0")) : "~"; }
function parseName(fname, path) {
  const base = fname.normalize("NFC").replace(/\.[^.]+$/, "");
  const r = { lang: detectLang(base), set_code: "", card_no: "", grade: "", title: "" };
  if (r.lang === "기타" && path) r.lang = langFromFolder(path);
  let rest = base, m = rest.match(RE_SETNUM);
  if (m) {
    r.set_code = m[2].toUpperCase(); r.card_no = r.set_code + "-" + m[3].toUpperCase();
    rest = rest.replace(m[0], m[1] + " ");
  } else if ((m = rest.match(RE_NUM))) {
    r.card_no = m[2]; rest = rest.replace(m[0], m[1] + " ");
  }
  const toks = rest.split(RE_SPLIT).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) {
    if (gradeList.includes(toks[i].toUpperCase())) { r.grade = toks[i].toUpperCase(); toks.splice(i, 1); break; }
  }
  r.title = toks.join(" ").trim();
  r.sort_key = sortKey(r.card_no);
  return r;
}
function applyMeta(meta, over) {
  if (!over) return meta;
  for (const k of ["lang", "set_code", "card_no", "grade", "title", "memo"]) {
    const v = String(over[k] ?? "").normalize("NFC").trim();
    if (v) meta[k] = ["grade", "card_no", "set_code"].includes(k) ? v.toUpperCase() : v;
  }
  if (over.card_no && !over.set_code) meta.set_code = meta.card_no.includes("-") ? meta.card_no.split("-")[0] : "";
  meta.sort_key = sortKey(meta.card_no);
  return meta;
}

/* ======================= 카드 정보 (번호 = 이미지 파일명) ======================= */
const INFO_FIELDS = ["no", "name_ko", "name_jp", "tan", "grade", "type", "brand", "source", "part", "codi", "qty", "memo"];
const INFO_ALIASES = {
  no: ["번호", "카드번호", "카드 번호", "no", "number", "파일명"],
  name_ko: ["이름", "한국어이름", "한국어 이름", "카드명", "한글이름", "name"],
  name_jp: ["일본어이름", "일본어 이름", "일본명", "일어이름", "name_jp"],
  tan: ["탄", "시리즈", "탄수"], grade: ["등급", "레어도", "grade", "rarity"], type: ["타입", "type"], brand: ["브랜드", "brand"],
  source: ["배출처", "출처"], part: ["부위", "종류"], codi: ["코디"], qty: ["수량", "보유수량", "개수"], memo: ["메모", "비고", "memo"]
};
const infoKey = s => String(s ?? "").normalize("NFC").replace(/\s+/g, "").toUpperCase();
const stemKey = f => infoKey(String(f || "").normalize("NFC").replace(/\.[^.]+$/, ""));
const numKey = s => { s = infoKey(s); return s ? s.replace(/\d+/g, m => m.padStart(6, "0")) : "~"; };
const PART_ORDER = { "상의": 1, "탑스": 1, "하의": 2, "보텀스": 2, "원피스": 3, "슈즈": 4, "신발": 4, "악세": 5, "악세서리": 5, "액세서리": 5, "액세": 5 };
const partRank = p => PART_ORDER[String(p || "").trim()] || 9;
function tanRank(t) {   // 1탄~6탄 → 2014 1탄~ → 2015 … → 프로모션(연도순, 연도 없는 프로모션이 맨 끝) → 빈 값
  t = String(t || "").normalize("NFC").trim(); if (!t) return 99999999;
  const promo = t.includes("프로모션"), y = t.match(/(20\d\d)/), n = t.match(/(\d+)\s*탄/);
  const year = y ? +y[1] : (promo ? 9999 : 0);
  return (promo ? 1 : 0) * 10000000 + year * 100 + (n ? +n[1] : 0);
}
let infoMap = new Map();
const EMPTY = {};
const I = c => (c.info_key && infoMap.get(c.info_key)) || EMPTY;
const RE_NAMEY = /[가-힣぀-ヿ一-鿿]/;
const nameOf = c => I(c).name_ko || (RE_NAMEY.test(c.title || "") ? c.title : "");
const gradeOf = c => I(c).grade || c.grade || "";
const noOf = c => I(c).no || c.card_no || "";
const memoOf = c => [I(c).memo, c.memo].filter(Boolean).join("\n");

/* 카드 ↔ 카드 정보 연결 (파일명 = 번호, "번호_2" 같은 이미지는 번호, 번호-2 … 순서로) */
async function linkAll() {
  const keys = new Set(infoMap.keys());
  const used = new Set(cards.filter(c => c.info_manual && c.info_key).map(c => c.info_key));
  const res = new Map(), groups = new Map();
  for (const c of [...cards].sort((a, b) => a.id - b.id)) {
    if (c.info_manual) continue;
    const k = stemKey(c.file_name);
    if (keys.has(k)) { res.set(c.id, k); used.add(k); continue; }
    const m = k.match(/^(.+?)_(\d+)$/);
    if (m) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push([+m[2], c.id]); }
    else res.set(c.id, "");
  }
  for (const [base, items] of groups) {
    const cands = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => base + "-" + n)].filter(x => keys.has(x));
    const free = cands.filter(x => !used.has(x));
    items.sort((a, b) => a[0] - b[0]).forEach(([, id]) => {
      if (free.length) { const k = free.shift(); res.set(id, k); used.add(k); } else res.set(id, cands[0] || "");
    });
  }
  const changed = [];
  for (const [id, k] of res) { const c = byId.get(id); if (c && (c.info_key || "") !== k) { c.info_key = k; changed.push(c); } }
  if (changed.length) await putCards(changed);
  return cards.filter(c => c.info_key).length;
}
/* 카드 정보 저장: 텍스트의 빈 칸은 기존 값(직접 입력한 수량·메모 등)을 지우지 않음 */
async function saveInfos(list) {
  const t = tx("info", "readwrite"), st = t.objectStore("info"); let ins = 0, upd = 0;
  for (const r of list) {
    if (!r.key) continue;
    const old = infoMap.get(r.key), rec = old ? Object.assign({}, old) : { key: r.key };
    for (const f of INFO_FIELDS) { const v = String(r[f] ?? "").normalize("NFC").trim(); if (v || !old) rec[f] = v || rec[f] || ""; }
    rec.updated_at = nowStr(); st.put(rec); infoMap.set(r.key, rec); old ? upd++ : ins++;
  }
  await txDone(t); return { ins, upd };
}
async function putInfo(rec) { rec.updated_at = nowStr(); const t = tx("info", "readwrite"); t.objectStore("info").put(rec); await txDone(t); infoMap.set(rec.key, rec); }
function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf);
  for (const enc of ["utf-8", "euc-kr", "shift_jis"]) { try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch (e) { } }
  return new TextDecoder("utf-8").decode(buf);
}
function parseInfoText(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r\n|\n|\r/)[0] || "";
  const rows = first.includes("\t") ? text.split(/\r\n|\n|\r/).filter(l => l.trim()).map(l => l.split("\t"))
    : parseCsv(text).filter(r => r.some(x => String(x).trim()));
  const head = (rows.shift() || []).map(x => String(x).normalize("NFC").replace(/\s/g, "").toLowerCase());
  const col = {}, taken = new Set();
  head.forEach((h, idx) => {
    for (const f of INFO_FIELDS) {
      if (col[f] !== undefined) continue;
      if (INFO_ALIASES[f].map(n => n.replace(/\s/g, "").toLowerCase()).includes(h)) { col[f] = idx; taken.add(idx); break; }
    }
  });
  if (col.no === undefined) throw new Error("첫 줄에 '번호' 열이 없습니다.");
  return rows.map(r => { const o = {}; for (const f in col) o[f] = String(r[col[f]] ?? "").normalize("NFC").trim(); o.key = infoKey(o.no); return o; }).filter(o => o.key);
}
async function importInfoFile(file) {
  const list = parseInfoText(decodeText(await file.arrayBuffer()));
  const r = await saveInfos(list); const linked = await linkAll();
  return `카드 정보 ${list.length.toLocaleString()}행 (신규 ${r.ins.toLocaleString()}, 갱신 ${r.upd.toLocaleString()}) · 정보가 연결된 카드 ${linked.toLocaleString()}장`;
}
/* 이 카드의 카드 정보 레코드 (없으면 파일명을 번호로 새로 만듦) */
async function ensureInfo(c) {
  if (c.info_key && infoMap.has(c.info_key)) return infoMap.get(c.info_key);
  const no = String(c.file_name || "").normalize("NFC").replace(/\.[^.]+$/, "");
  const key = c.info_key || infoKey(no);
  const rec = infoMap.get(key) || { key, no, name_ko: RE_NAMEY.test(c.title || "") ? c.title : "", name_jp: "", tan: "", grade: c.grade || "", type: "", brand: "", source: "", part: "", codi: "", qty: "", memo: "" };
  await putInfo(rec);
  if (c.info_key !== key) { c.info_key = key; await putCards([c]); }
  return rec;
}

/* ======================= 데이터 (메모리 목록) ======================= */
let cards = [], byId = new Map(), bySha = new Map();
async function loadAll() {
  cards = await reqP(tx("cards").objectStore("cards").getAll());
  byId = new Map(cards.map(c => [c.id, c])); bySha = new Map(cards.map(c => [c.sha256, c]));
  infoMap = new Map((await reqP(tx("info").objectStore("info").getAll())).map(r => [r.key, r]));
  // 사용자 정렬 순서가 없는 카드(이전 버전)는 등록 순서대로 뒤에 붙임
  const miss = cards.filter(c => typeof c.user_order !== "number").sort((a, b) => a.id - b.id);
  if (miss.length) { let o = maxOrder(); miss.forEach(c => c.user_order = (o += 1024)); await putCards(miss); }
}
const maxOrder = () => cards.reduce((m, c) => typeof c.user_order === "number" && c.user_order > m ? c.user_order : m, 0);
const gradeRank = g => { const i = gradeList.indexOf(String(g || "").split(/[\s+/]/)[0].toUpperCase()); return i < 0 ? 999 : i; };

/* ======================= 썸네일·해시 ======================= */
async function sha256(buf) {
  if (crypto.subtle) {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57; const a = new Uint8Array(buf);   // (https가 아닐 때 대체)
  for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 2654435761); h2 = Math.imul(h2 ^ a[i], 1597334677); }
  return "x" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16);
}
function loadImg(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error("이미지를 열 수 없음")); };
    im.src = u;
  });
}
async function scaleImg(blob, W, type, q, longSide) {   // 썸네일: 가로 W / QR: 긴 변 W
  const im = await loadImg(blob);
  const scale = Math.min(1, W / (longSide ? Math.max(im.naturalWidth, im.naturalHeight) : im.naturalWidth));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(im.naturalWidth * scale)); cv.height = Math.max(1, Math.round(im.naturalHeight * scale));
  const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(im, 0, 0, cv.width, cv.height);
  return await new Promise(r => cv.toBlob(r, type, q));
}
async function makeThumb(blob) { try { return await scaleImg(blob, 260, "image/jpeg", 0.82); } catch (e) { return null; } }
/* QR 사진: 큰 사진은 긴 변 1600px로 줄여서 저장 (QR은 충분히 읽힘) */
async function shrinkQr(blob) {
  if (blob.size < 1.2e6) return blob;
  try { return (await scaleImg(blob, 1600, "image/jpeg", 0.9, true)) || blob; } catch (e) { return blob; }
}
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", heif: "image/heif" };
const mimeOf = n => MIME[(n.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
const extOf = b => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic" }[b.type] || ".jpg");

/* ======================= 등록 ======================= */
/* item: {name, path, blob|getBlob(), meta?, extra?: {info_key, liked, getQr()}} */
const STATUS_KO = { added: "신규 등록", dup: "중복 건너뜀", updated: "정보 갱신", skip: "이미지 아님", error: "오류" };
async function registerBatch(items, dup, st, onEach) {
  // 1) 읽기·해시·썸네일 (트랜잭션 밖)
  const prepared = [];
  for (const it of items) {
    if (st.cancel) break;
    st.current = it.path || it.name;
    try {
      if (!IMG_RE.test(it.name)) { prepared.push({ it, status: "skip" }); continue; }
      let blob = it.blob || await it.getBlob();
      if (!blob.type) blob = new Blob([blob], { type: mimeOf(it.name) });
      const buf = await blob.arrayBuffer();
      const sha = await sha256(buf);
      const meta = applyMeta(parseName(it.name, it.path), it.meta);
      const qr = it.extra && it.extra.getQr ? await it.extra.getQr().catch(() => null) : null;
      const old = bySha.get(sha) || prepared.find(p => p.sha === sha && p.status === "added");
      if (old) { prepared.push({ it, status: dup === "update" && old.id ? "updated" : "dup", sha, meta, old, qr }); continue; }
      const thumb = await makeThumb(blob);
      prepared.push({ it, status: "added", sha, meta, blob, thumb, qr });
    } catch (e) { prepared.push({ it, status: "error", err: e.message }); }
  }
  // 2) 한 번에 저장
  const t = tx(["cards", "files", "qr"], "readwrite");
  const cs = t.objectStore("cards"), fs = t.objectStore("files"), qs = t.objectStore("qr");
  const now = nowStr();
  const extra = (rec, p, keepOld) => {
    const x = p.it.extra; if (!x) return;
    if (x.info_key && !(keepOld && rec.info_key)) { rec.info_key = x.info_key; rec.info_manual = 1; }
    if (x.liked) rec.liked = 1;
    if (p.qr && !(keepOld && rec.has_qr)) { rec.has_qr = 1; p.qrFor = true; }
  };
  for (const p of prepared) {
    if (p.status === "added") {
      const rec = Object.assign({ file_name: p.it.name.normalize("NFC"), src_path: (p.it.path || "").normalize("NFC"), memo: "", sha256: p.sha, size: p.blob.size, mime: p.blob.type, created_at: now, updated_at: now, liked: 0, has_qr: 0, info_key: "" }, p.meta);
      if (!rec.memo) rec.memo = "";
      rec.user_order = (st.nextOrder = (st.nextOrder || maxOrder()) + 1024);   // 사용자 정렬: 맨 뒤에
      extra(rec, p, false);
      const r = cs.add(rec);
      r.onsuccess = () => { rec.id = r.result; p.id = rec.id; fs.put({ img: p.blob, thumb: p.thumb }, rec.id); if (p.qrFor) qs.put(p.qr, rec.id); p.rec = rec; };
    } else if (p.status === "updated") {
      const rec = Object.assign({}, p.old, p.meta, { memo: p.meta.memo || p.old.memo, updated_at: now });
      extra(rec, p, false);
      cs.put(rec); if (p.qrFor) qs.put(p.qr, rec.id); p.rec = rec; p.id = rec.id;
    } else if (p.status === "dup" && p.old.id && p.it.extra) {   // 중복이어도 좋아요·QR은 비어 있으면 채움
      const rec = Object.assign({}, p.old); const before = JSON.stringify([rec.liked, rec.has_qr, rec.info_key]);
      extra(rec, p, true);
      if (JSON.stringify([rec.liked, rec.has_qr, rec.info_key]) !== before) { cs.put(rec); if (p.qrFor) qs.put(p.qr, rec.id); p.rec = rec; }
    }
  }
  await txDone(t);
  for (const p of prepared) {
    if (p.rec) { byId.set(p.rec.id, p.rec); bySha.set(p.rec.sha256, p.rec); if (p.status === "added") cards.push(p.rec); else { const i = cards.findIndex(c => c.id === p.rec.id); if (i >= 0) cards[i] = p.rec; } }
    onEach(p);
  }
}

/* 파일 목록 펼치기: 이미지 / ZIP(PC 백업 포함) */
function decodeZipName(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { }
  const score = t => { let s = 0; for (const ch of t) { const o = ch.codePointAt(0);
    if (o < 128) continue; if (o >= 0xFF61 && o <= 0xFF9F) s -= 2; else if (o >= 0x3040 && o <= 0x30FF) s += 2;
    else if (o >= 0xAC00 && o <= 0xD7A3) s += 2; else if (o >= 0x4E00 && o <= 0x9FFF) s += 1; else s -= 1; } return s; };
  const c = [];
  for (const enc of ["euc-kr", "shift_jis"]) { try { c.push(new TextDecoder(enc, { fatal: true }).decode(bytes)); } catch (e) { } }
  if (!c.length) return new TextDecoder("euc-kr").decode(bytes);
  return c.sort((a, b) => score(b) - score(a))[0];
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
/* ZIP 펼치기 → {items, infos}. PC·휴대폰 백업 ZIP의 카드목록.csv에서 카드 정보·좋아요·QR 사진까지 읽음 */
async function expandZip(file, notes) {
  const zip = await JSZip.loadAsync(file, { decodeFileName: decodeZipName });
  const files = new Map(); zip.forEach((p, e) => { if (!e.dir) files.set(p.normalize("NFC"), e); });
  const metaByPath = {}, infos = [];
  const csvEntry = [...files].find(([p]) => /(^|\/)카드목록\.csv$/.test(p));
  if (csvEntry) {
    const prefix = csvEntry[0].replace(/카드목록\.csv$/, "");
    let text = await csvEntry[1].async("string"); text = text.replace(/^﻿/, "");
    const rows = parseCsv(text), h = (rows.shift() || []).map(x => x.trim());
    const col = n => h.indexOf(n);
    const ci = { lang: col("언어"), set_code: col("세트"), card_no: col("카드번호"), grade: col("등급"), title: col("카드명"), memo: col("메모"), path: col("ZIP 안 경로"),
      ino: col("정보 번호"), jp: col("일본어 이름"), tan: col("탄"), type: col("타입"), brand: col("브랜드"), source: col("배출처"), part: col("부위"), codi: col("코디"), qty: col("수량"), imemo: col("정보 메모"), liked: col("좋아요"), qr: col("QR 경로") };
    const g = (r, k) => ci[k] >= 0 ? String(r[ci[k]] ?? "").normalize("NFC").trim() : "";
    for (const r of rows) {
      const ino = g(r, "ino");
      if (ino) infos.push({ key: infoKey(ino), no: ino, name_ko: g(r, "title"), name_jp: g(r, "jp"), tan: g(r, "tan"), grade: g(r, "grade"), type: g(r, "type"), brand: g(r, "brand"), source: g(r, "source"), part: g(r, "part"), codi: g(r, "codi"), qty: g(r, "qty"), memo: g(r, "imemo") });
      const p = g(r, "path"); if (!p) continue;
      const m = {}; for (const k of ["lang", "set_code", "card_no", "grade", "title", "memo"]) m[k] = g(r, k);
      const qp = g(r, "qr"), qe = qp && files.get(prefix + qp);
      m._extra = { info_key: ino ? infoKey(ino) : "", liked: g(r, "liked") === "1", getQr: qe ? async () => new Blob([await qe.async("uint8array")], { type: mimeOf(qp) }) : null };
      metaByPath[prefix + p] = m;
    }
  }
  const out = [];
  for (const [path, e] of files) {
    const name = path.split("/").pop();
    if (name.startsWith("._") || path.includes("__MACOSX/") || /(^|\/)QR사진\//.test(path)) continue;
    if (TXT_RE.test(name) && !/카드목록\.csv$/.test(name)) {   // ZIP 안의 번호 설명 파일
      try { infos.push(...parseInfoText(decodeText(await e.async("arraybuffer")))); } catch (x) { }
      continue;
    }
    if (!IMG_RE.test(name)) continue;
    let meta = metaByPath[path], extra = null;
    if (meta) { extra = meta._extra; delete meta._extra; }
    else {   // PC 카드DB 저장소 폴더 구조: 카드이미지저장소/언어/등급/파일
      const m = path.match(/(?:^|\/)(한국어|일본어|기타)\/([^/]+)\/[^/]+$/);
      if (m) meta = { lang: m[1] === "기타" ? "" : m[1], grade: m[2] === "등급없음" ? "" : m[2] };
    }
    out.push({ name, path: file.name + "/" + path, meta, extra, getBlob: async () => new Blob([await e.async("uint8array")], { type: mimeOf(name) }) });
  }
  if (!out.length && !infos.length) notes.push(file.name + ": ZIP 안에 이미지가 없습니다.");
  return { items: out, infos };
}

/* ======================= 화면: 목록 ======================= */
const FKEYS = ["lang", "grade", "tan", "part", "codi"];
const FGET = { lang: c => c.lang, grade: gradeOf, tan: c => I(c).tan, part: c => I(c).part, codi: c => I(c).codi };
let filtered = [], page = 0, sel = newSel(), picked = new Set(), detIdx = -1;
function newSel() { return Object.fromEntries(FKEYS.map(k => [k, new Set()])); }
let pageUrls = [];
function fmtMB(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : (b / 1048576).toFixed(1) + " MB"; }
function toast(msg, ms = 2500) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", ms); }

function countBy(fn) { const m = new Map(); for (const c of cards) { const k = fn(c) || "(없음)"; m.set(k, (m.get(k) || 0) + 1); } return m; }
function checks(el, key, list) {
  el.innerHTML = "";
  for (const k of [...sel[key]]) if (!list.some(x => x[0] === k)) sel[key].delete(k);
  for (const [k, n] of list) {
    const l = document.createElement("label"); l.className = "chk";
    l.innerHTML = `<span><input type="checkbox" ${sel[key].has(k) ? "checked" : ""}> ${esc(k)}</span><span class="cnt">${n.toLocaleString()}</span>`;
    l.querySelector("input").onchange = e => { e.target.checked ? sel[key].add(k) : sel[key].delete(k); page = 0; apply(); };
    el.appendChild(l);
  }
}
const noneLast = (a, b) => (a[0] === "(없음)") - (b[0] === "(없음)");
function buildFacets() {
  const lo = ["한국어", "일본어", "기타"];
  const L = [...countBy(FGET.lang)].sort((a, b) => lo.indexOf(a[0]) - lo.indexOf(b[0]));
  const G = [...countBy(FGET.grade)].sort((a, b) => noneLast(a, b) || gradeRank(a[0]) - gradeRank(b[0]) || a[0].localeCompare(b[0]));
  const T = [...countBy(FGET.tan)].sort((a, b) => noneLast(a, b) || tanRank(a[0]) - tanRank(b[0]));
  const P = [...countBy(FGET.part)].sort((a, b) => noneLast(a, b) || partRank(a[0]) - partRank(b[0]));
  const C = [...countBy(FGET.codi)].sort((a, b) => noneLast(a, b) || a[0].localeCompare(b[0], "ko"));
  checks($("fLang"), "lang", L); checks($("fGrade"), "grade", G); checks($("fTan"), "tan", T); checks($("fPart"), "part", P); checks($("fCodi"), "codi", C);
  $("cLiked").textContent = cards.filter(c => c.liked).length.toLocaleString();
  $("cQr").textContent = cards.filter(c => c.has_qr).length.toLocaleString();
  $("cNoInfo").textContent = cards.filter(c => !I(c).no).length.toLocaleString();
  $("cNoGrade").textContent = cards.filter(c => !gradeOf(c)).length.toLocaleString();
  const bytes = cards.reduce((a, c) => a + (c.size || 0), 0);
  $("hInfo").textContent = `카드 ${cards.length.toLocaleString()}장 · ${fmtMB(bytes)}`;
  let h = `<tr><td><b>전체</b></td><td><b>${cards.length.toLocaleString()}</b></td></tr>`;
  h += `<tr><td>카드 정보 연결</td><td>${cards.filter(c => I(c).no).length.toLocaleString()}</td></tr>`;
  h += `<tr><td>♥ 좋아요</td><td>${$("cLiked").textContent}</td></tr>`;
  T.forEach(([k, n]) => h += `<tr><td>${esc(k)}</td><td>${n.toLocaleString()}</td></tr>`);
  $("stat").innerHTML = h;
  $("codiList").innerHTML = C.filter(x => x[0] !== "(없음)").map(([k, n]) => `<option value="${esc(k)}">${n}장</option>`).join("");
}
/* 코디별 정렬: 탄 순서 → 같은 탄 안에서는 코디의 첫 카드(가장 앞 번호) 자리에 그 코디를 모음 → 상의·하의·원피스·슈즈·악세 */
function codiFirstMap() {
  const m = new Map();
  for (const r of infoMap.values()) if (r.codi) { const k = (r.tan || "") + "\u0001" + r.codi, v = numKey(r.no); if (!m.has(k) || v < m.get(k)) m.set(k, v); }
  return m;
}
function currentFilter() {
  const words = $("q").value.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
  const noInfo = $("fNoInfo").checked, noGrade = $("fNoGrade").checked, liked = $("fLiked").checked, hasQr = $("fQr").checked;
  let list = cards.filter(c => {
    for (const k of FKEYS) if (sel[k].size && !sel[k].has(FGET[k](c) || "(없음)")) return false;
    if (noInfo && I(c).no) return false;
    if (noGrade && gradeOf(c)) return false;
    if (liked && !c.liked) return false;
    if (hasQr && !c.has_qr) return false;
    if (words.length) {
      const i = I(c);
      const hay = [nameOf(c), i.name_jp, noOf(c), c.file_name, i.tan, gradeOf(c), i.type, i.brand, i.source, i.part, i.codi, memoOf(c)].join(" ").toLowerCase();
      for (const w of words) if (!hay.includes(w)) return false;
    }
    return true;
  });
  const cmp = (a, b) => (a || "").localeCompare(b || "", "ko", { numeric: true });
  const nk = new Map(list.map(c => [c.id, numKey(noOf(c)) || c.sort_key]));
  const byNum = (a, b) => cmp(nk.get(a.id), nk.get(b.id)) || cmp(a.lang, b.lang) || a.id - b.id;
  const s = $("sort").value;
  if (s === "codi") {
    const first = codiFirstMap(), key = new Map();
    for (const c of list) { const i = I(c); key.set(c.id, [tanRank(i.tan), i.codi ? (first.get((i.tan || "") + "\u0001" + i.codi) || nk.get(c.id)) : nk.get(c.id), i.codi ? 0 : 1, i.codi || "", partRank(i.part)]); }
    list.sort((a, b) => { const x = key.get(a.id), y = key.get(b.id);
      return x[0] - y[0] || cmp(x[1], y[1]) || x[2] - y[2] || cmp(x[3], y[3]) || x[4] - y[4] || byNum(a, b); });
  } else list.sort({
    num: byNum, grade: (a, b) => gradeRank(gradeOf(a)) - gradeRank(gradeOf(b)) || byNum(a, b),
    name: (a, b) => (!nameOf(a)) - (!nameOf(b)) || cmp(nameOf(a), nameOf(b)) || byNum(a, b),
    liked: (a, b) => (b.liked ? 1 : 0) - (a.liked ? 1 : 0) || byNum(a, b),
    new: (a, b) => b.id - a.id,
    user: (a, b) => (a.user_order || 0) - (b.user_order || 0) || a.id - b.id
  }[s] || byNum);
  return list;
}
function apply() {
  filtered = currentFilter();
  const ps = +$("psize").value;
  if (page * ps >= filtered.length) page = Math.max(0, Math.ceil(filtered.length / ps) - 1);
  render();
}
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  pageUrls.forEach(u => URL.revokeObjectURL(u)); pageUrls = [];
  const ps = +$("psize").value, total = filtered.length, pages = Math.max(1, Math.ceil(total / ps));
  const items = filtered.slice(page * ps, page * ps + ps);
  $("rInfo").textContent = `${total.toLocaleString()}장`;
  const box = $("content");
  if (!cards.length) { box.innerHTML = `<div class="empty">아직 등록된 카드가 없습니다.<br>[등록]을 눌러 카드 사진이나 ZIP 파일, 번호 설명 파일을 추가하세요.<br><br><button class="btn primary" onclick="openReg()">카드 등록하기</button></div>`; $("pager").innerHTML = ""; return; }
  if (!total) { box.innerHTML = `<div class="empty">조건에 맞는 카드가 없습니다.</div>`; $("pager").innerHTML = ""; return; }
  const codiSort = $("sort").value === "codi";
  if ($("view").value === "grid") {
    box.innerHTML = `<div class="grid">${items.map((c, k) => { const i = I(c), nm = nameOf(c), g = gradeOf(c); return `<div class="card ${picked.has(c.id) ? "sel" : ""}" data-k="${k}">
      <input type="checkbox" class="pick" ${picked.has(c.id) ? "checked" : ""}>
      <div class="img"><img data-id="${c.id}" alt="">${c.liked ? `<span class="hrt">♥</span>` : ""}${c.has_qr ? `<span class="qrm">QR</span>` : ""}${codiSort && i.codi ? `<span class="cdb">👗 ${esc(i.codi)}</span>` : ""}</div>
      <div class="meta"><div class="ttl">${nm ? esc(nm) : '<span class="noname">이름 없음</span>'}</div>
      <div class="sub">${g ? `<span class="tag gr">${esc(g)}</span>` : ""}${esc(i.tan || noOf(c))}</div></div></div>`; }).join("")}</div>`;
  } else {
    box.innerHTML = `<table class="list"><tr><th></th><th>♥</th><th>번호</th><th>이름</th><th>탄</th><th>등급</th><th class="hm">부위</th><th class="hm">코디</th><th class="hm">수량</th></tr>${items.map((c, k) => { const i = I(c); return `
      <tr data-k="${k}" class="${picked.has(c.id) ? "sel" : ""}"><td class="thumb"><img data-id="${c.id}" alt=""></td><td style="color:#d81b60">${c.liked ? "♥" : ""}</td><td>${esc(noOf(c))}</td><td>${esc(nameOf(c))}</td><td>${esc(i.tan)}</td><td>${esc(gradeOf(c))}</td><td class="hm">${esc(i.part)}</td><td class="hm">${esc(i.codi)}</td><td class="hm">${esc(i.qty)}</td></tr>`; }).join("")}</table>`;
  }
  if ($("sort").value === "user") box.querySelectorAll(".grid .card").forEach((el, k) => { const o = document.createElement("span"); o.className = "ordno"; o.textContent = page * ps + k + 1; el.querySelector(".img").appendChild(o); });
  $("tbUser").style.display = $("sort").value === "user" && !document.body.classList.contains("selmode") ? "flex" : "none";
  setupTouchDrag(box, items, ps);
  box.querySelectorAll("[data-k]").forEach(el => el.onclick = () => {
    if (dragJustEnded) return;
    const c = items[+el.dataset.k];
    if (document.body.classList.contains("selmode")) {
      picked.has(c.id) ? picked.delete(c.id) : picked.add(c.id);
      el.classList.toggle("sel", picked.has(c.id)); const cb = el.querySelector(".pick"); if (cb) cb.checked = picked.has(c.id);
      $("selCnt").textContent = `${picked.size}장 선택`;
    } else openDetail(page * ps + +el.dataset.k);
  });
  // 페이지 번호
  let p = `<button class="btn" ${page === 0 ? "disabled" : ""} data-p="${page - 1}">◀</button>`;
  const a = Math.max(0, page - 2), b = Math.min(pages - 1, page + 2);
  if (a > 0) p += `<button class="btn" data-p="0">1</button>${a > 1 ? "…" : ""}`;
  for (let i = a; i <= b; i++) p += `<button class="btn ${i === page ? "primary" : ""}" data-p="${i}">${i + 1}</button>`;
  if (b < pages - 1) p += `${b < pages - 2 ? "…" : ""}<button class="btn" data-p="${pages - 1}">${pages}</button>`;
  p += `<button class="btn" ${page >= pages - 1 ? "disabled" : ""} data-p="${page + 1}">▶</button>`;
  $("pager").innerHTML = p;
  $("pager").querySelectorAll("[data-p]").forEach(x => x.onclick = () => { page = +x.dataset.p; render(); $("content").scrollTop = 0; });
  // 썸네일 (한 트랜잭션에서 읽기)
  const imgs = [...box.querySelectorAll("img[data-id]")];
  const store = tx("files").objectStore("files");
  const got = await Promise.all(imgs.map(im => reqP(store.get(+im.dataset.id)).catch(() => null)));
  if (seq !== renderSeq) return;
  got.forEach((f, i) => { if (!f) return; const u = URL.createObjectURL(f.thumb || f.img); pageUrls.push(u); imgs[i].src = u; });
}
async function refresh() { buildFacets(); apply(); }

/* ======================= 순서 옮기기 (어느 정렬에서나: 길게 눌러 끌기) ======================= */
const SORT_NAME = () => { const o = $("sort").selectedOptions[0]; return o ? o.textContent : ""; };
/* 사용자 정렬이 아니면: 지금 보이는 순서를 사용자 정렬 순서로 가져옴 (보이는 카드들 자리 안에서만). 되돌리기용 백업 */
async function adoptOrder() {
  if ($("sort").value === "user") return false;
  const backup = {}; cards.forEach(c => backup[c.id] = c.user_order);
  await setSetting("order_backup", backup);
  const slots = filtered.map(c => c.user_order).sort((a, b) => a - b);
  filtered.forEach((c, i) => c.user_order = slots[i]);
  await putCards(filtered);
  $("sort").value = "user"; setSetting("sort", "user").catch(() => { });
  return true;
}
/* ids 카드를 지금 목록의 pos번째 자리(0부터, 옮길 카드를 뺀 목록 기준)로 */
async function moveCardsTo(ids, pos) {
  const from = SORT_NAME(), adopted = await adoptOrder();
  const set = new Set(ids);
  const list = [...filtered].sort((a, b) => a.user_order - b.user_order || a.id - b.id);
  const moving = list.filter(c => set.has(c.id)), rest = list.filter(c => !set.has(c.id));
  pos = Math.max(0, Math.min(rest.length, pos));
  let lo = pos > 0 ? rest[pos - 1].user_order : (rest.length ? rest[0].user_order - 1024 * (moving.length + 1) : 0);
  let hi = pos < rest.length ? rest[pos].user_order : lo + 1024 * (moving.length + 1);
  if ((hi - lo) / (moving.length + 1) < 1e-6) {   // 간격이 좁아지면 전체 다시 번호
    [...cards].sort((a, b) => a.user_order - b.user_order || a.id - b.id).forEach((c, i) => c.user_order = (i + 1) * 1024);
    await putCards(cards); return moveCardsTo(ids, pos);
  }
  const step = (hi - lo) / (moving.length + 1);
  moving.forEach((c, i) => c.user_order = lo + step * (i + 1));
  await putCards(moving);
  filtered = currentFilter(); render();
  toast(adopted ? `'${from}' 순서를 사용자 정렬로 가져와 옮겼습니다. ([되돌리기] 가능)` : `${moving.length > 1 ? moving.length + "장을 " : ""}옮겼습니다.`, adopted ? 3500 : 1500);
}
$("bOrdUndo").onclick = async () => {
  const b = await getSetting("order_backup", null); if (!b) return toast("되돌릴 내용이 없습니다.");
  if (!confirm("다른 정렬에서 옮기기 전의 사용자 정렬 순서로 되돌릴까요?")) return;
  cards.forEach(c => { if (b[c.id] !== undefined) c.user_order = b[c.id]; }); await putCards(cards);
  await setSetting("order_backup", null); filtered = currentFilter(); render(); toast("되돌렸습니다.");
};
/* 길게 누른 뒤 끌기 (터치·마우스 공통). 짧게 누르면 그대로 카드 열기, 바로 밀면 화면 스크롤 */
let dragJustEnded = false;
function setupTouchDrag(box, items, ps) {
  const grid = $("view").value === "grid";
  box.querySelectorAll("[data-k]").forEach(el => {
    let timer = null, sx = 0, sy = 0, drag = null;
    const pt = e => e.touches ? e.touches[0] || e.changedTouches[0] : e;
    const start = e => {
      if (e.button > 0) return;
      const p = pt(e); sx = p.clientX; sy = p.clientY;
      timer = setTimeout(() => begin(p), 450);
    };
    const begin = p => {
      timer = null;
      const c = items[+el.dataset.k];
      const ids = picked.has(c.id) && picked.size > 1 ? [...picked] : [c.id];
      const ghost = el.cloneNode(true); ghost.className += " ghost";
      const r = el.getBoundingClientRect(); ghost.style.width = r.width + "px";
      document.body.appendChild(ghost);
      if (ids.length > 1) { const b = document.createElement("span"); b.className = "ghostcnt"; b.textContent = ids.length + "장"; ghost.appendChild(b); }
      drag = { ids, ghost, ox: p.clientX - r.left, oy: p.clientY - r.top, target: null, after: false, scroll: 0 };
      el.classList.add("dragging"); try { navigator.vibrate && navigator.vibrate(25); } catch (x) { }
      place(p);
      drag.timer = setInterval(() => { if (drag && drag.scroll) $("content").scrollTop += drag.scroll; }, 16);
    };
    const place = p => {
      drag.ghost.style.left = (p.clientX - drag.ox) + "px"; drag.ghost.style.top = (p.clientY - drag.oy) + "px";
      drag.ghost.style.display = "none"; const under = document.elementFromPoint(p.clientX, p.clientY); drag.ghost.style.display = "";
      const t = under && under.closest("#content [data-k]");
      document.querySelectorAll(".drop-before,.drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
      if (t && t !== el) { const r = t.getBoundingClientRect(); drag.after = grid ? p.clientX > r.left + r.width / 2 : p.clientY > r.top + r.height / 2;
        t.classList.add(drag.after ? "drop-after" : "drop-before"); drag.target = t; } else drag.target = null;
      const cr = $("content").getBoundingClientRect();   // 위·아래 끝에서 자동 스크롤
      drag.scroll = p.clientY < cr.top + 60 ? -12 : p.clientY > cr.bottom - 60 ? 12 : 0;
    };
    const move = e => {
      const p = pt(e);
      if (timer && (Math.abs(p.clientX - sx) > 8 || Math.abs(p.clientY - sy) > 8)) { clearTimeout(timer); timer = null; }
      if (drag) { if (e.cancelable) e.preventDefault(); place(p); }
    };
    const end = async e => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!drag) return;
      const d = drag; drag = null; clearInterval(d.timer); d.ghost.remove(); el.classList.remove("dragging");
      document.querySelectorAll(".drop-before,.drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
      dragJustEnded = true; setTimeout(() => dragJustEnded = false, 350);
      if (!d.target || e.type === "touchcancel") return;
      const tc = items[+d.target.dataset.k]; if (d.ids.includes(tc.id)) return;
      const rest = filtered.filter(c => !d.ids.includes(c.id));
      await moveCardsTo(d.ids, rest.indexOf(tc) + (d.after ? 1 : 0));
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end); el.addEventListener("touchcancel", end);
    el.addEventListener("mousedown", e => { start(e);
      const mm = ev => move(ev), mu = ev => { document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); end(ev); };
      document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu); });
    el.addEventListener("contextmenu", e => e.preventDefault());
  });
}
/* 카드 정보 화면에서 순서 옮기기 */
async function moveDetailTo(n) {
  const c = filtered[detIdx]; if (!c) return;
  await moveCardsTo([c.id], n - 1);
  const j = filtered.indexOf(c); if (j >= 0) { page = Math.floor(j / +$("psize").value); render(); openDetail(j); }
}
$("bOrdFirst").onclick = () => moveDetailTo(1);
$("bOrdLast").onclick = () => moveDetailTo(1e9);
$("bOrdGo").onclick = () => { const n = parseInt($("eOrd").value, 10); if (!(n > 0)) return toast("몇 번째로 옮길지 숫자를 넣으세요."); moveDetailTo(n); };

/* ======================= 카드 정보 시트 ======================= */
let detUrls = [];
const shortGrade = g => String(g || "").split(/\s*\+\s*/)[0].trim();
async function thumbUrl(id) { const f = await getFile(id); if (!f) return ""; const u = URL.createObjectURL(f.thumb || f.img); detUrls.push(u); return u; }
async function openDetail(k) {
  detIdx = k; const c = filtered[k]; if (!c) return;
  detUrls.forEach(u => URL.revokeObjectURL(u)); detUrls = [];
  const i = I(c), g = gradeOf(c);
  const f = await getFile(c.id);
  if (f) { const u = URL.createObjectURL(f.img); detUrls.push(u); $("dImg").src = u; } else $("dImg").removeAttribute("src");
  $("dCnt").textContent = `${(k + 1).toLocaleString()} / ${filtered.length.toLocaleString()}`;
  $("bPrev").disabled = k <= 0; $("bNext").disabled = k >= filtered.length - 1;
  $("dGb").textContent = shortGrade(g); $("dGb").style.display = g ? "" : "none";
  $("dNko").textContent = nameOf(c) || "이름 없음";
  $("dNjp").textContent = i.name_jp || ""; $("dNjp").style.display = i.name_jp ? "" : "none";
  $("dNno").textContent = [noOf(c), g].filter(Boolean).join(" ") || "번호 없음";
  const chips = [];
  if (i.tan) chips.push(`<span class="chip">${esc(i.tan)}</span>`);
  if (g) chips.push(`<span class="chip gold">★ ${esc(g)}</span>`);
  if (i.type) chips.push(`<span class="chip type">${esc(i.type)}</span>`);
  if (i.brand) chips.push(`<span class="chip line">${esc(i.brand)}</span>`);
  if (i.source) chips.push(`<span class="chip">${esc(i.source)}</span>`);
  if (i.part) chips.push(`<span class="chip">${esc(i.part)}</span>`);
  if (i.codi) chips.push(`<span class="chip codi">👗 ${esc(i.codi)}</span>`);
  if (c.lang && c.lang !== "기타") chips.push(`<span class="chip line">${esc(c.lang)}</span>`);
  $("dChips").innerHTML = chips.join("");
  showHeart(c); showQrBtn(c);
  $("dActLbl").textContent = [c.liked ? "♥ 좋아요" : "", c.has_qr ? "QR 사진 있음" : ""].filter(Boolean).join(" · ");
  const memo = memoOf(c); $("dMemo").textContent = memo || "메모 없음"; $("dMemo").classList.toggle("none", !memo);
  $("dQty").textContent = parseInt(i.qty, 10) || 0;
  $("dOrd").textContent = `${(k + 1).toLocaleString()} / ${filtered.length.toLocaleString()}`; $("eOrd").value = "";
  $("editBox").classList.remove("open");
  $("dRo").innerHTML = `${esc(c.file_name)} · ${(c.size / 1024).toFixed(0)} KB · 등록 ${esc(c.created_at)}${c.src_path ? `<br>가져온 위치: ${esc(c.src_path)}` : ""}`;
  show("dDet"); $("sheet").scrollTop = 0;
  // 같은 코디 (다른 탄 포함): 같은 탄이 먼저(상의·하의·원피스·슈즈·악세 순) → 탄 순서 → 프로모션탄
  const seq = detIdx;
  const sc = i.codi ? cards.filter(x => I(x).codi === i.codi) : [];
  sc.sort((a, b) => { const x = I(a), y = I(b);
    return ((x.tan || "") === (i.tan || "") ? 0 : 1) - ((y.tan || "") === (i.tan || "") ? 0 : 1) || tanRank(x.tan) - tanRank(y.tan) || partRank(x.part) - partRank(y.part) || numKey(x.no).localeCompare(numKey(y.no)) || a.id - b.id; });
  $("dCodiWrap").style.display = sc.length > 1 ? "" : "none";
  $("dCodiCnt").textContent = sc.length > 1 ? `${i.codi} · ${sc.length}장, 다른 탄 포함` : "";
  let h = "", cur = null;
  for (const x of sc) {
    const xi = I(x);
    if (xi.tan !== cur) { if (cur !== null) h += "</div>"; cur = xi.tan;
      h += `<div class="tanhd">${esc(xi.tan || "탄 없음")}${(xi.tan || "") === (i.tan || "") ? " · 이 카드와 같은 탄" : ""} (${sc.filter(y => I(y).tan === xi.tan).length}장)</div><div class="thumbs">`; }
    h += `<div data-cid="${x.id}" class="${x.id === c.id ? "cur" : ""}"><img data-tid="${x.id}" alt="">${esc(xi.part || "-")}<br>${esc(nameOf(x) || xi.no)}</div>`;
  }
  $("dCodi").innerHTML = h + (sc.length ? "</div>" : "");
  // 같은 번호의 다른 카드
  const same = cards.filter(x => x.id !== c.id && ((c.info_key && x.info_key === c.info_key) || (!c.info_key && c.card_no && x.card_no === c.card_no))).slice(0, 12);
  $("dSameWrap").style.display = same.length ? "" : "none";
  $("dSame").innerHTML = same.map(x => `<div data-cid="${x.id}"><img data-tid="${x.id}" alt="">${esc(x.lang)}</div>`).join("");
  document.querySelectorAll("#dCodi [data-cid], #dSame [data-cid]").forEach(el => el.onclick = () => jumpTo(+el.dataset.cid, i.codi));
  for (const im of document.querySelectorAll("#dCodi img[data-tid], #dSame img[data-tid]")) {
    const u = await thumbUrl(+im.dataset.tid); if (seq !== detIdx) return; if (u) im.src = u;
  }
}
async function jumpTo(id, codi) {
  const c = filtered[detIdx]; if (c && c.id === id) return;
  let j = filtered.findIndex(x => x.id === id); if (j >= 0) return openDetail(j);
  // 지금 목록에 없으면 이 코디만 보이게 바꾼 뒤 열기
  $("q").value = ""; ["fNoInfo", "fNoGrade", "fLiked", "fQr"].forEach(x => $(x).checked = false); sel = newSel();
  if (codi) sel.codi.add(codi);
  await refresh(); j = filtered.findIndex(x => x.id === id); if (j >= 0) openDetail(j);
}
function showHeart(c) { const b = $("bHeart"); b.classList.toggle("on", !!c.liked); b.textContent = c.liked ? "♥" : "♡"; $("dFh").style.display = c.liked ? "" : "none"; }
function showQrBtn(c) { $("bQr").classList.toggle("on", !!c.has_qr); }
async function setLike(list, on) {
  list.forEach(c => c.liked = on ? 1 : 0); await putCards(list);
  buildFacets(); if ($("fLiked").checked || $("sort").value === "liked") filtered = currentFilter(); render();
}
$("bHeart").onclick = async () => {
  const c = filtered[detIdx]; if (!c) return;
  await setLike([c], !c.liked); showHeart(c);
  $("dActLbl").textContent = [c.liked ? "♥ 좋아요" : "", c.has_qr ? "QR 사진 있음" : ""].filter(Boolean).join(" · ");
  const j = filtered.indexOf(c); if (j >= 0) { detIdx = j; $("dCnt").textContent = `${(j + 1).toLocaleString()} / ${filtered.length.toLocaleString()}`; }
  toast(c.liked ? "♥ 좋아요에 넣었습니다." : "좋아요를 해제했습니다.", 1500);
};
async function changeQty(d) {
  const c = filtered[detIdx]; if (!c) return;
  const rec = await ensureInfo(c); const n = Math.max(0, (parseInt(rec.qty, 10) || 0) + d);
  rec.qty = String(n); await putInfo(rec); $("dQty").textContent = n;
}
$("bQm").onclick = () => changeQty(-1);
$("bQp").onclick = () => changeQty(1);
/* 수정하기 */
const EFIELDS = [["eName", "name_ko"], ["eJp", "name_jp"], ["eTan", "tan"], ["eGrade", "grade"], ["eType", "type"], ["eBrand", "brand"], ["eSource", "source"], ["ePart", "part"], ["eCodi", "codi"]];
$("bEdit").onclick = () => {
  const c = filtered[detIdx]; if (!c) return; const i = I(c);
  EFIELDS.forEach(([id, f]) => $(id).value = f === "name_ko" ? nameOf(c) : f === "grade" ? gradeOf(c) : (i[f] || ""));
  $("eNo").value = noOf(c) || String(c.file_name || "").replace(/\.[^.]+$/, ""); $("eMemo").value = memoOf(c);
  $("editBox").classList.add("open"); setTimeout(() => $("editBox").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
};
$("bEditCancel").onclick = () => $("editBox").classList.remove("open");
$("bSave").onclick = async () => {
  const c = filtered[detIdx]; if (!c) return;
  const no = $("eNo").value.normalize("NFC").trim(), key = infoKey(no) || c.info_key;
  if (key && key !== c.info_key) {   // 번호를 바꾸면 그 번호의 카드 정보와 연결
    c.info_key = key; c.info_manual = 1; await putCards([c]);
  }
  const rec = await ensureInfo(c);
  if (no) rec.no = no;
  EFIELDS.forEach(([id, f]) => rec[f] = $(id).value.normalize("NFC").trim());
  rec.memo = $("eMemo").value.normalize("NFC").trim();
  if (c.memo) { c.memo = ""; await putCards([c]); }   // 메모는 카드 정보 메모 하나로 합침
  await putInfo(rec);
  buildFacets(); filtered = currentFilter(); render(); toast("저장했습니다.");
  const j = filtered.indexOf(c); if (j >= 0) openDetail(j); else closeAll();
};
async function deleteIds(ids) {
  const t = tx(["cards", "files", "qr"], "readwrite"), cs = t.objectStore("cards"), fs = t.objectStore("files"), qs = t.objectStore("qr");
  for (const id of ids) { cs.delete(id); fs.delete(id); qs.delete(id); }
  await txDone(t);
  const s = new Set(ids);
  cards = cards.filter(c => !s.has(c.id));
  for (const id of ids) { const c = byId.get(id); if (c) bySha.delete(c.sha256); byId.delete(id); picked.delete(id); }
}
$("bDel").onclick = async () => {
  const c = filtered[detIdx]; if (!c) return;
  if (!confirm(`[${noOf(c) || "번호없음"}] ${nameOf(c) || c.file_name}\n이 카드 이미지를 삭제할까요? (카드 정보는 남습니다)`)) return;
  await deleteIds([c.id]); const k = detIdx; await refresh(); toast("삭제했습니다.");
  if (filtered.length) openDetail(Math.min(k, filtered.length - 1)); else closeAll();
};
$("bPrev").onclick = () => { if (detIdx > 0) openDetail(detIdx - 1); };
$("bNext").onclick = () => { if (detIdx < filtered.length - 1) openDetail(detIdx + 1); };
(() => {
  let x0 = null, y0 = 0; const el = $("dBig");
  el.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchend", e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? $("bNext") : $("bPrev")).click(); });
})();
$("dDet").addEventListener("click", e => { if (e.target.id === "dDet") closeAll(); });   // 시트 바깥을 누르면 닫기
document.addEventListener("keydown", e => {
  if ($("dDet").style.display !== "flex" || e.target.matches("input,textarea")) return;
  if ($("dQr").style.display === "flex") { if (e.key === "Escape") hide("dQr"); return; }
  if (e.key === "Escape") closeAll(); if (e.key === "ArrowLeft") $("bPrev").click(); if (e.key === "ArrowRight") $("bNext").click();
});

/* ======================= QR 사진 ======================= */
let qrUrl = "";
async function openQr(c) {
  const b = await getQr(c.id);
  if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = b ? URL.createObjectURL(b) : "";
  $("qrTitle").textContent = `QR 사진 · ${nameOf(c) || noOf(c) || c.file_name}`;
  $("qrView").innerHTML = qrUrl ? `<img src="${qrUrl}" alt="QR">` : `<div class="hint">QR 사진이 없습니다.</div>`;
  $("bQrSave").style.display = $("bQrDel").style.display = qrUrl ? "" : "none";
  $("bQrChange").textContent = qrUrl ? "바꾸기" : "사진 넣기";
  show("dQr");
}
$("bQr").onclick = () => { const c = filtered[detIdx]; if (!c) return; c.has_qr ? openQr(c) : $("upQr").click(); };   // 없으면 바로 사진 고르기(촬영·앨범)
$("bQrChange").onclick = () => $("upQr").click();
$("bQrClose").onclick = () => hide("dQr");
$("upQr").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; const c = filtered[detIdx]; if (!f || !c) return;
  let blob = f.type ? f : new Blob([f], { type: mimeOf(f.name) });
  blob = await shrinkQr(blob);
  const t = tx(["qr", "cards"], "readwrite"); t.objectStore("qr").put(blob, c.id); c.has_qr = 1; t.objectStore("cards").put(c); await txDone(t);
  showQrBtn(c); $("dActLbl").textContent = [c.liked ? "♥ 좋아요" : "", "QR 사진 있음"].filter(Boolean).join(" · ");
  buildFacets(); render(); toast("QR 사진을 넣었습니다."); openQr(c);
};
$("bQrSave").onclick = async () => { const c = filtered[detIdx]; const b = c && await getQr(c.id); if (b) saveBlob(`QR_${safePart(noOf(c) || c.file_name.replace(/\.[^.]+$/, ""), "card")}${extOf(b)}`, b); };
$("bQrDel").onclick = async () => {
  const c = filtered[detIdx]; if (!c || !confirm("이 카드의 QR 사진을 지울까요?")) return;
  const t = tx(["qr", "cards"], "readwrite"); t.objectStore("qr").delete(c.id); c.has_qr = 0; t.objectStore("cards").put(c); await txDone(t);
  showQrBtn(c); hide("dQr"); buildFacets(); render(); toast("QR 사진을 지웠습니다.");
  $("dActLbl").textContent = c.liked ? "♥ 좋아요" : "";
};

/* ======================= 선택 모드 ======================= */
function selMode(on) { document.body.classList.toggle("selmode", on); $("tbSel").style.display = on ? "flex" : "none"; $("tbMain").style.display = on ? "none" : "flex"; if (!on) picked.clear(); $("selCnt").textContent = `${picked.size}장 선택`; render(); }
$("bSelMode").onclick = () => selMode(!document.body.classList.contains("selmode"));
$("bSelExit").onclick = () => selMode(false);
$("bSelPage").onclick = () => { const ps = +$("psize").value; filtered.slice(page * ps, page * ps + ps).forEach(c => picked.add(c.id)); $("selCnt").textContent = `${picked.size}장 선택`; render(); };
$("bSelNone").onclick = () => { picked.clear(); $("selCnt").textContent = "0장 선택"; render(); };
$("bSelDel").onclick = async () => {
  if (!picked.size) return toast("삭제할 카드를 선택하세요.");
  if (!confirm(`선택한 ${picked.size}장을 삭제할까요?\n이 휴대폰에서 완전히 지워집니다.`)) return;
  const n = picked.size; await deleteIds([...picked]); $("selCnt").textContent = "0장 선택"; await refresh(); toast(`${n}장 삭제했습니다.`);
};
$("bSelAll").onclick = () => { filtered.forEach(c => picked.add(c.id)); $("selCnt").textContent = `${picked.size}장 선택`; render(); };
$("bSelEdit").onclick = () => {
  if (!picked.size) return toast("수정할 카드를 선택하세요.");
  $("bulkTitle").textContent = `선택한 ${picked.size.toLocaleString()}장 일괄 수정`;
  ["kCodi", "kGrade", "kMemo"].forEach(id => $(id).value = ""); $("kLang").value = ""; $("kLike").value = ""; $("kCodiClr").checked = false;
  const first = cards.find(c => picked.has(c.id) && I(c).codi); if (first) $("kCodi").placeholder = `예) ${I(first).codi}`;
  show("dBulk");
};
$("bBulkApply").onclick = async () => {
  const lang = $("kLang").value, grade = $("kGrade").value.trim().toUpperCase(), memo = $("kMemo").value.normalize("NFC").trim();
  const codi = $("kCodi").value.normalize("NFC").trim(), codiClr = $("kCodiClr").checked, like = $("kLike").value;
  if (!lang && !grade && !memo && !codi && !codiClr && !like) return toast("바꿀 항목을 입력하세요.");
  const now = nowStr(), list = cards.filter(c => picked.has(c.id));
  for (const c of list) {
    if (codi || codiClr || grade || memo) {
      const rec = await ensureInfo(c);
      if (codi || codiClr) rec.codi = codiClr ? "" : codi;
      if (grade) rec.grade = grade;
      if (memo) rec.memo = rec.memo ? rec.memo + " " + memo : memo;
      await putInfo(rec);
    }
    if (lang) c.lang = lang; if (like) c.liked = like === "1" ? 1 : 0;
    c.updated_at = now;
  }
  await putCards(list);
  hide("dBulk"); await refresh(); toast(`${list.length.toLocaleString()}장 수정했습니다.`);
};
$("bSelDl").onclick = () => { if (!picked.size) return toast("다운로드할 카드를 선택하세요."); downloadZip(cards.filter(c => picked.has(c.id)), `카드이미지_선택_${picked.size}장`); };

/* ======================= 다운로드 · 저장 ======================= */
const stamp = () => new Date().toLocaleString("sv-SE").slice(0, 10).replace(/-/g, "");
function safePart(s, empty) { return (s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || empty; }
async function blobToB64Chunks(blob, size, fn) {
  for (let off = 0; off < blob.size; off += size) {
    const part = blob.slice(off, off + size);
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(r.error); r.readAsDataURL(part); });
    fn(b64, off + part.size);
  }
}
let pendingSave = null;
async function saveBlob(name, blob) {
  if (IS_ANDROID_APP) {   // 갤럭시 앱: 다운로드 폴더(Download/카드DB)에 저장
    const tok = CardApp.saveBegin(name, blob.type || mimeOf(name));
    if (!tok) return toast("저장할 수 없습니다.");
    await blobToB64Chunks(blob, 3 * 256 * 1024, (b64, done) => { CardApp.saveChunk(tok, b64); if (blob.size > 3e6) $("toast").textContent = `저장 중… ${Math.floor(done / blob.size * 100)}%`; });
    const where = CardApp.saveEnd(tok);
    return toast(where ? `저장했습니다: ${where}` : "저장에 실패했습니다.", 3500);
  }
  if (IS_IOS_APP) {   // 아이폰 앱: 공유 화면(이미지 저장 / 파일에 저장)
    const tok = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    IOS_BRIDGE.postMessage({ op: "begin", tok, name, mime: blob.type || mimeOf(name) });
    await blobToB64Chunks(blob, 3 * 256 * 1024, (b64, done) => { IOS_BRIDGE.postMessage({ op: "chunk", tok, b64 }); if (blob.size > 3e6) toast(`준비 중… ${Math.floor(done / blob.size * 100)}%`); });
    IOS_BRIDGE.postMessage({ op: "end", tok });
    return;
  }
  const file = new File([blob], name, { type: blob.type || mimeOf(name) });
  if (IS_IOS && navigator.canShare && navigator.canShare({ files: [file] })) {   // 아이폰: 공유 시트로 저장 (탭이 필요)
    pendingSave = file;
    $("saveTxt").textContent = `${name} (${fmtMB(blob.size)}) 준비가 끝났습니다.`;
    show("dSave"); return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
$("bShare").onclick = async () => {
  if (!pendingSave) return;
  try { await navigator.share({ files: [pendingSave] }); hide("dSave"); pendingSave = null; }
  catch (e) { if (e.name !== "AbortError") toast("저장 실패: " + e.message); }
};
$("bDl1").onclick = async () => {
  const c = filtered[detIdx]; const f = await getFile(c.id); if (!f) return toast("이미지가 없습니다.");
  saveBlob(c.file_name, f.img);
};
/* 카드목록.csv — PC 카드DB와 같은 열 (서로 ZIP으로 옮길 수 있음) */
const CSV_HEAD = ["ID", "언어", "세트", "카드번호", "등급", "카드명", "메모", "ZIP 안 경로", "비고", "정보 번호", "일본어 이름", "탄", "타입", "브랜드", "배출처", "부위", "코디", "수량", "정보 메모", "좋아요", "QR 경로"];
const csvRow = (c, arc, qarc) => { const i = I(c); return [c.id, c.lang, c.set_code, c.card_no, gradeOf(c), nameOf(c) || c.title, c.memo, arc || "", arc === undefined ? "" : arc ? "" : "이미지 없음",
  i.no || "", i.name_jp, i.tan, i.type, i.brand, i.source, i.part, i.codi, i.qty, i.memo, c.liked ? 1 : 0, qarc || ""]; };
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
async function downloadZip(list, base) {
  if (!list.length) return toast("받을 카드가 없습니다.");
  const bytes = list.reduce((a, c) => a + (c.size || 0), 0);
  if (!confirm(`${list.length.toLocaleString()}장 (약 ${fmtMB(bytes)})을 ZIP 파일로 저장할까요?\nZIP 안은 언어/등급 폴더로 정리되고 카드목록.csv(카드 정보·좋아요)와 QR 사진이 함께 들어갑니다.`)) return;
  closeMenu(); show("dReg"); setBusy(true, true);
  const st = { done: 0, total: list.length, t0: Date.now() };
  const zip = new JSZip(), used = new Set(), rows = [];
  try {
    const sorted = [...list].sort((a, b) => numKey(noOf(a)).localeCompare(numKey(noOf(b))) || a.id - b.id);
    for (let i = 0; i < sorted.length; i += 50) {
      const chunk = sorted.slice(i, i + 50), t = tx(["files", "qr"]), fsx = t.objectStore("files"), qsx = t.objectStore("qr");
      const files = await Promise.all(chunk.map(c => reqP(fsx.get(c.id))));
      const qrs = await Promise.all(chunk.map(c => c.has_qr ? reqP(qsx.get(c.id)) : null));
      chunk.forEach((c, j) => {
        let arc = `${safePart(c.lang, "기타")}/${safePart(shortGrade(gradeOf(c)), "등급없음")}/${safePart(c.file_name, "image.png")}`;
        const dot = arc.lastIndexOf("."), stem = dot > 0 ? arc.slice(0, dot) : arc, ext = dot > 0 ? arc.slice(dot) : "";
        for (let n = 2; used.has(arc); n++) arc = `${stem} (${n})${ext}`;
        used.add(arc);
        let ok = "", qarc = "";
        if (files[j]) { zip.file(arc, files[j].img); ok = arc;
          if (qrs[j]) { qarc = "QR사진/" + arc.replace(/\.[^./]+$/, "") + extOf(qrs[j]); zip.file(qarc, qrs[j]); } }
        rows.push(csvRow(c, ok, qarc));
      });
      st.done = Math.min(sorted.length, i + 50);
      showProg({ msg: "ZIP 준비 중", done: st.done, total: st.total, elapsed: (Date.now() - st.t0) / 1000 });
      if (cancelReq) throw new Error("사용자가 중단함");
    }
    zip.file("카드목록.csv", "﻿" + [CSV_HEAD.join(",")].concat(rows.map(r => r.map(q).join(","))).join("\r\n"));
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, m => {
      $("progTxt").textContent = `ZIP 만드는 중… ${Math.floor(m.percent)}%`; $("progBar").style.width = m.percent + "%";
    });
    $("progTxt").textContent = `ZIP 완성 (${fmtMB(blob.size)})`;
    setBusy(false); hide("dReg");
    await saveBlob(`${base}_${stamp()}.zip`, blob);
  } catch (e) { setBusy(false); $("progTxt").textContent = e.message; toast(e.message); }
}
function exportCsv() {
  const list = filtered.length ? filtered : cards;
  const head = CSV_HEAD.filter(h => !["ZIP 안 경로", "비고", "QR 경로"].includes(h)).concat(["파일명", "등록일"]);
  const csv = "﻿" + [head.join(",")].concat(list.map(c => { const r = csvRow(c); r.splice(7, 2); r.pop(); return r.concat([c.file_name, c.created_at]).map(q).join(","); })).join("\r\n");
  saveBlob(`카드목록_${stamp()}.csv`, new Blob([csv], { type: "text/csv" }));
}

/* ======================= 등록 화면 ======================= */
let staged = [], busy = false, cancelReq = false, regLog = [];
function openReg() { show("dReg"); }
window.openReg = openReg;
$("bReg").onclick = openReg;
function stage(list) {
  staged = staged.concat([...list].filter(f => IMG_RE.test(f.name) || ZIP_RE.test(f.name) || TXT_RE.test(f.name)));
  const img = staged.filter(f => IMG_RE.test(f.name)).length, zip = staged.filter(f => ZIP_RE.test(f.name)).length, txt = staged.filter(f => TXT_RE.test(f.name)).length;
  $("stageBox").style.display = staged.length ? "" : "none";
  $("stageTxt").innerHTML = `등록 대기: 이미지 <b>${img.toLocaleString()}</b>장${zip ? `, ZIP <b>${zip}</b>개` : ""}${txt ? `, 설명 파일 <b>${txt}</b>개` : ""} (${fmtMB(staged.reduce((a, f) => a + f.size, 0))})`;
  $("stageList").innerHTML = staged.slice(0, 200).map(f => `<div>${TXT_RE.test(f.name) ? "📄 " : ""}${esc(f.webkitRelativePath || f.name)}</div>`).join("") + (staged.length > 200 ? `<div>… 외 ${(staged.length - 200).toLocaleString()}개</div>` : "");
}
$("upFiles").onchange = e => { stage(e.target.files); e.target.value = ""; };
$("upCam").onchange = e => { stage(e.target.files); e.target.value = ""; if (staged.length === 1) $("bStart").click(); };
$("upDir").onchange = e => { stage(e.target.files); e.target.value = ""; };
$("bClr").onclick = () => { staged = []; stage([]); };
const dz = $("dropZone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove("over")));
dz.addEventListener("drop", async e => {
  e.preventDefault();
  const ents = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!ents.length) return stage(e.dataTransfer.files);
  const out = [];
  async function walk(en, path) {
    if (en.isFile) { const f = await new Promise((r, j) => en.file(r, j)); try { Object.defineProperty(f, "webkitRelativePath", { value: path + f.name }); } catch (x) { } out.push(f); }
    else if (en.isDirectory) { const r = en.createReader(); let b; do { b = await new Promise((s, j) => r.readEntries(s, j)); for (const x of b) await walk(x, path + en.name + "/"); } while (b.length); }
  }
  for (const en of ents) await walk(en, "");
  stage(out);
});
let wakeLock = null;
async function keepAwake(on) {
  try { if (IS_ANDROID_APP && CardApp.keepAwake) CardApp.keepAwake(on); } catch (e) { }
  try { if (IS_IOS_APP) IOS_BRIDGE.postMessage({ op: "awake", on: !!on }); } catch (e) { }
  try {
    if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
function setBusy(on, noStart) {
  busy = on; cancelReq = false; keepAwake(on);
  $("bStart").disabled = on; $("bClr").disabled = on; $("bCancel").style.display = on ? "" : "none";
  if (on) { $("bLog").style.display = "none"; $("prog").style.display = ""; $("progErr").textContent = ""; $("progCnt").innerHTML = ""; $("progCur").textContent = ""; }
}
function fmtTime(s) { if (!isFinite(s) || s < 0) return "-"; s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m}분 ${s % 60}초` : `${s}초`; }
function showProg(j) {
  $("prog").style.display = "";
  const rate = j.elapsed > 0 ? j.done / j.elapsed : 0;
  $("progTxt").textContent = `${j.msg} · ${j.done.toLocaleString()} / ${j.total.toLocaleString()}` + (j.total ? ` (${Math.floor(j.done / j.total * 100)}%)` : "") +
    (rate && j.done < j.total ? ` · 남은 시간 약 ${fmtTime((j.total - j.done) / rate)}` : "");
  $("progBar").style.width = (j.total ? j.done / j.total * 100 : 0) + "%";
  if (j.added !== undefined) $("progCnt").innerHTML = `<span>신규 <b>${j.added}</b></span><span>중복 <b>${j.dup}</b></span><span>갱신 <b>${j.updated}</b></span><span style="color:#b02a2a">오류 <b>${j.error}</b></span>`;
  $("progCur").textContent = j.current ? "처리 중: " + j.current : "";
}
$("bCancel").onclick = () => { cancelReq = true; };
$("bStart").onclick = () => startReg();
async function startReg() {
  if (busy) return;
  if (!staged.length) return toast("먼저 [사진·파일 선택]으로 등록할 파일을 고르세요.");
  setBusy(true); regLog = [];
  const dup = document.querySelector("input[name=oDup]:checked").value;
  const st = { msg: "파일 확인 중", done: 0, total: 0, added: 0, dup: 0, updated: 0, skip: 0, error: 0, t0: Date.now(), cancel: false };
  const notes = []; let infoMsg = "";
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  try {
    // 펼치기 (설명 파일 → 카드 정보)
    let items = [], infos = [];
    for (const f of staged) {
      if (ZIP_RE.test(f.name)) {
        $("progTxt").textContent = `ZIP 여는 중: ${f.name}`;
        try { const r = await expandZip(f, notes); items = items.concat(r.items); infos = infos.concat(r.infos); } catch (e) { notes.push(`${f.name}: ZIP을 열 수 없음 (${e.message})`); }
      } else if (TXT_RE.test(f.name)) {
        try { infos = infos.concat(parseInfoText(decodeText(await f.arrayBuffer()))); } catch (e) { notes.push(`${f.name}: ${e.message}`); }
      } else items.push({ name: f.name, path: f.webkitRelativePath || "", blob: f });
    }
    if (infos.length) {
      const r = await saveInfos(infos);
      infoMsg = `카드 정보 ${infos.length.toLocaleString()}행 (신규 ${r.ins.toLocaleString()}, 갱신 ${r.upd.toLocaleString()})`;
      regLog.push(["카드 정보", infoMsg, ""]);
    }
    notes.forEach(n => regLog.push(["오류", n, ""]));
    st.error += notes.length; st.total = items.length; st.msg = "등록 중";
    $("progErr").textContent = notes.join("\n");
    const B = 25;
    for (let i = 0; i < items.length; i += B) {
      if (cancelReq) { st.msg = "사용자가 중단함"; break; }
      st.cancel = cancelReq;
      await registerBatch(items.slice(i, i + B), dup, st, p => {
        st[p.status]++; st.done++;
        regLog.push([STATUS_KO[p.status], p.it.path || p.it.name, p.err || ""]);
        if (p.status === "error") $("progErr").textContent += `${p.it.name}: ${p.err}\n`;
      });
      st.elapsed = (Date.now() - st.t0) / 1000; showProg(st);
    }
    const linked = await linkAll();
    if (st.msg === "등록 중") st.msg = "완료";
    st.current = ""; st.elapsed = (Date.now() - st.t0) / 1000; showProg(st);
    if (infoMsg || items.length) $("progCur").textContent = [infoMsg, `카드 정보가 연결된 카드 ${linked.toLocaleString()}장 / 전체 ${cards.length.toLocaleString()}장`].filter(Boolean).join(" · ");
    staged = []; stage([]);
    toast(items.length ? `등록 완료: 신규 ${st.added}장, 중복 ${st.dup}장` : (infoMsg || "완료"), 3500);
  } catch (e) {
    $("progErr").textContent += "\n" + e.message; toast("오류: " + e.message, 4000);
  } finally {
    setBusy(false); $("bLog").style.display = ""; await refresh();
  }
  return st;
}
$("bLog").onclick = () => {
  saveBlob(`등록결과_${stamp()}.csv`, new Blob(["﻿결과,파일,메시지\r\n" + regLog.map(r => r.map(q).join(",")).join("\r\n")], { type: "text/csv" }));
};
$("upInfo").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { const m = await importInfoFile(f); await refresh(); toast(m, 4500); } catch (x) { toast("가져오기 실패: " + x.message, 4500); }
};

/* ======================= 기본 카드 데이터 (설치판에 함께 들어 있는 카드) ======================= */
let seedIdx = null;
async function seedIndex() {
  try { const r = await fetch("seed/index.json", { cache: "no-store" }); if (!r.ok) return null; const j = await r.json(); return j && j.parts && j.parts.length ? j : null; }
  catch (e) { return null; }
}
async function runSeed(idx) {
  if (busy) return toast("작업 중입니다.");
  openReg(); const m = $("seedMsg");
  m.style.display = ""; m.textContent = `기본 카드 데이터(카드 ${Number(idx.cards).toLocaleString()}장·카드 정보)를 넣고 있습니다. 화면을 켜 둔 채 기다려 주세요. 몇 분 걸릴 수 있습니다.`;
  const files = [];
  try {
    $("prog").style.display = "";
    for (let i = 0; i < idx.parts.length; i++) {
      $("progTxt").textContent = `기본 데이터 여는 중 ${i + 1} / ${idx.parts.length}`; $("progBar").style.width = (i / idx.parts.length * 100) + "%";
      const r = await fetch("seed/" + idx.parts[i]); if (!r.ok) throw new Error(idx.parts[i] + " 을(를) 읽을 수 없습니다.");
      files.push(new File([await r.blob()], idx.parts[i], { type: "application/zip" }));
    }
  } catch (e) { m.textContent = "기본 카드 데이터를 넣지 못했습니다: " + e.message; return; }
  staged = []; stage(files);
  const st = await startReg();
  if (st && st.msg === "완료") { await setSetting("seeded", idx.version); m.textContent = `기본 카드 데이터를 넣었습니다. (신규 ${st.added.toLocaleString()}장, 이미 있던 카드 ${st.dup.toLocaleString()}장)`; }
  else m.textContent = "기본 카드 데이터를 넣다가 멈췄습니다. [더보기 > 설정]의 [기본 카드 데이터 넣기]로 이어서 넣을 수 있습니다 (이미 들어간 카드는 건너뜀).";
}

/* ======================= 메뉴 · 설정 ======================= */
function closeMenu() { $("menu").style.display = "none"; }
$("bMenu").onclick = e => { e.stopPropagation(); $("menu").style.display = $("menu").style.display === "block" ? "none" : "block"; };
document.addEventListener("click", e => { if (!$("menu").contains(e.target)) closeMenu(); });
$("menu").onclick = e => {
  const a = e.target.dataset.act; if (!a) return; closeMenu();
  if (a === "info") $("upInfo").click();
  if (a === "dlRes") downloadZip(filtered, `카드이미지_검색결과_${filtered.length}장`);
  if (a === "dlAll") downloadZip(cards, `카드DB_백업_전체_${cards.length}장`);
  if (a === "csv") exportCsv();
  if (a === "set") openSettings();
};
async function openSettings() {
  $("sGrades").value = gradeList.join(", ");
  let s = `등록된 카드 ${cards.length.toLocaleString()}장 · 원본 이미지 ${fmtMB(cards.reduce((a, c) => a + (c.size || 0), 0))} · 카드 정보 ${infoMap.size.toLocaleString()}개`;
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); s += `<br>앱 사용 공간 ${fmtMB(e.usage || 0)} / 사용 가능 ${fmtMB(e.quota || 0)}`; } } catch (e) { }
  try { if (navigator.storage && navigator.storage.persisted) s += `<br>데이터 보존: ${(await navigator.storage.persisted()) ? "영구 저장" : "일반"}`; } catch (e) { }
  $("sStore").innerHTML = s;
  $("seedBox").style.display = seedIdx ? "" : "none";
  if (seedIdx) $("seedInfo").textContent = `이 앱에 들어 있는 기본 카드 데이터: 카드 ${Number(seedIdx.cards).toLocaleString()}장 (v${seedIdx.version})`;
  $("sVer").textContent = `카드DB 휴대폰 앱 ${APP_VERSION} (${IS_ANDROID_APP ? "갤럭시 앱" : IS_IOS_APP ? "아이폰 앱" : IS_IOS ? "아이폰 홈 화면 앱" : "브라우저"})`;
  show("dSet");
}
async function saveGrades() {
  const g = $("sGrades").value.trim() || DEFAULT_GRADES;
  await setSetting("grades", g); gradeList = g.split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
}
$("bSaveSet").onclick = async () => { await saveGrades(); hide("dSet"); refresh(); toast("저장했습니다."); };
$("bReparse").onclick = async () => {
  if (!confirm("모든 카드를 파일 이름 기준으로 다시 분석하고 카드 정보와 다시 연결할까요?\n(카드 정보·좋아요·QR·메모는 유지)")) return;
  await saveGrades();
  for (const c of cards) { Object.assign(c, parseName(c.file_name, c.src_path)); c.info_manual = 0; }
  await putCards(cards); await linkAll(); hide("dSet"); refresh(); toast(`${cards.length.toLocaleString()}장 다시 분석했습니다.`);
};
$("bSeed").onclick = async () => {
  if (!seedIdx) return;
  if (!confirm(`기본 카드 데이터(카드 ${Number(seedIdx.cards).toLocaleString()}장)를 넣을까요?\n이미 있는 카드는 건너뛰고, 카드 정보는 비어 있는 칸만 채웁니다.`)) return;
  hide("dSet"); runSeed(seedIdx);
};
$("bWipe").onclick = async () => {
  if (!cards.length && !infoMap.size) return toast("삭제할 카드가 없습니다.");
  if (!confirm(`등록된 카드 ${cards.length.toLocaleString()}장과 카드 정보를 모두 삭제할까요?`)) return;
  if (prompt('되돌릴 수 없습니다. 계속하려면 "삭제"라고 입력하세요.') !== "삭제") return;
  const t = tx(["cards", "files", "info", "qr"], "readwrite"); ["cards", "files", "info", "qr"].forEach(s => t.objectStore(s).clear()); await txDone(t);
  cards = []; byId.clear(); bySha.clear(); infoMap.clear(); picked.clear(); hide("dSet"); refresh(); toast("모두 삭제했습니다.");
};

/* ======================= 공통 ======================= */
function show(id) { $(id).style.display = "flex"; }
function hide(id) { $(id).style.display = "none"; }
function closeAll() { document.querySelectorAll(".bg").forEach(b => { if (!(b.id === "dReg" && busy)) b.style.display = "none"; }); detIdx = -1; }
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { const bg = b.closest(".bg"); if (bg.id === "dReg" && busy) return toast("작업 중입니다. [중단] 후 닫으세요."); hide(bg.id); if (bg.id === "dDet") detIdx = -1; });
$("bFilter").onclick = () => document.body.classList.add("filters");
$("aClose").onclick = $("shade").onclick = () => document.body.classList.remove("filters");
$("q").addEventListener("keydown", e => { if (e.key === "Enter") { e.target.blur(); document.body.classList.remove("filters"); } });
let qt; $("q").oninput = () => { clearTimeout(qt); qt = setTimeout(() => { page = 0; apply(); }, 250); };
["fNoInfo", "fNoGrade", "fLiked", "fQr", "psize"].forEach(id => $(id).onchange = () => { page = 0; apply(); });
$("sort").onchange = () => { page = 0; setSetting("sort", $("sort").value).catch(() => { }); apply(); };
$("view").onchange = () => { setSetting("view", $("view").value).catch(() => { }); render(); };
$("bReset").onclick = () => { $("q").value = ""; ["fNoInfo", "fNoGrade", "fLiked", "fQr"].forEach(id => $(id).checked = false); sel = newSel(); page = 0; refresh(); };
/* 안드로이드 뒤로가기: 열린 창부터 닫음 */
window.appBack = function () {
  if ($("menu").style.display === "block") { closeMenu(); return true; }
  if (document.body.classList.contains("filters")) { document.body.classList.remove("filters"); return true; }
  for (const id of ["dSave", "dQr", "dBulk", "dSet", "dDet", "dReg"]) if ($(id).style.display === "flex") {
    if (id === "dReg" && busy) { toast("작업 중입니다."); return true; }
    if (id === "dDet" && $("editBox").classList.contains("open")) { $("editBox").classList.remove("open"); return true; }
    hide(id); if (id === "dDet") detIdx = -1; return true; }
  if (document.body.classList.contains("selmode")) { selMode(false); return true; }
  return false;
};

/* ======================= 시작 ======================= */
(async () => {
  try {
    idb = await openDB();
    gradeList = (await getSetting("grades", DEFAULT_GRADES)).split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
    const so = await getSetting("sort", "num"), vw = await getSetting("view", "grid");
    if ([...$("sort").options].some(o => o.value === so)) $("sort").value = so;
    if ([...$("view").options].some(o => o.value === vw)) $("view").value = vw;
    await loadAll(); await refresh();
    // 처음 실행: 앱에 들어 있는 기본 카드 데이터 넣기
    seedIdx = await seedIndex();
    if (seedIdx && (await getSetting("seeded", "")) !== seedIdx.version) {
      if (!cards.length || confirm(`이 앱에 기본 카드 데이터(카드 ${Number(seedIdx.cards).toLocaleString()}장·카드 정보)가 들어 있습니다.\n지금 넣을까요? (이미 있는 카드는 건너뜀)`)) runSeed(seedIdx);
      else await setSetting("seeded", seedIdx.version);
    }
  } catch (e) {
    $("content").innerHTML = `<div class="empty">데이터베이스를 열 수 없습니다.<br>${esc(e.message)}<br><br>아이폰은 Safari의 개인정보 보호 모드를 끄고, 홈 화면에 추가한 앱으로 실행해 주세요.</div>`;
  }
  window.appSaved = ok => { if (ok) toast("저장했습니다."); };
  if (!IS_ANDROID_APP && !IS_IOS_APP && "serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => { });
})();
