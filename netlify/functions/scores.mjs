// 全能王挑戰：全班分數的即時儲存
// GET  /api/scores?room=1234                  → { ok, room, locked, rows:[{name,a,b}] }
// POST /api/scores { room, id, name, a, b }   → 提交一名學生的分數（每部裝置只記錄第一次）
// POST /api/scores { room, action:"lock" }    → 截止提交
// POST /api/scores { room, action:"unlock" }  → 重新開放
//
// 每名學生的資料直接寫在 blob 的 key 內（room/id_名字_手速_心算，名字以十六進制編碼），
// 所以讀取全班數據只需一次 list()，而且不同學生同時提交不會互相覆寫。
import { getStore } from "@netlify/blobs";

const ROOM = /^\d{4}$/;
const ID = /^[a-f0-9]{8,32}$/;
const MAX_ROWS = 80;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const MAX_NAME = 12; // 名字或學號最多 12 個字
const cleanName = (v) => [...String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, MAX_NAME).join("");
const enc = (t) => Buffer.from(t, "utf8").toString("hex");
const dec = (h) => (/^([0-9a-f]{2})+$/.test(h) ? Buffer.from(h, "hex").toString("utf8") : "");

async function readRoom(store, room) {
  const { blobs } = await store.list({ prefix: room + "/" });
  const rows = [];
  let locked = false;
  for (const { key } of blobs) {
    const rest = key.slice(room.length + 1);
    if (rest === "LOCK") { locked = true; continue; }
    const p = rest.split("_");
    if (p.length === 4) rows.push({ id: p[0], name: dec(p[1]) || "?", a: Number(p[2]), b: Number(p[3]) });
  }
  rows.sort((x, y) => x.name.localeCompare(y.name, "zh-Hant", { numeric: true }) || (x.id < y.id ? -1 : 1));
  return { rows, locked };
}

export default async (req) => {
  try {
    const store = getStore({ name: "class-scores", consistency: "strong" });

    if (req.method === "GET") {
      const room = new URL(req.url).searchParams.get("room") || "";
      if (!ROOM.test(room)) return json({ ok: false, error: "room" }, 400);
      const { rows, locked } = await readRoom(store, room);
      return json({ ok: true, room, locked, rows: rows.map(({ name, a, b }) => ({ name, a, b })) });
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "json" }, 400); }
      const room = String(body.room || "");
      if (!ROOM.test(room)) return json({ ok: false, error: "room" }, 400);

      if (body.action === "lock") { await store.set(room + "/LOCK", "1"); return json({ ok: true, locked: true }); }
      if (body.action === "unlock") { await store.delete(room + "/LOCK"); return json({ ok: true, locked: false }); }

      const { id, a, b } = body;
      const name = cleanName(body.name);
      if (!ID.test(String(id || "")) || !name || !int(a, 0, 400) || !int(b, 0, 150)) {
        return json({ ok: false, error: "invalid" }, 400);
      }
      const { rows, locked } = await readRoom(store, room);
      const mine = rows.find((r) => r.id === id);
      if (mine) return json({ ok: true, duplicate: true, name: mine.name, a: mine.a, b: mine.b });
      if (locked) return json({ ok: false, error: "locked" }, 409);
      if (rows.length >= MAX_ROWS) return json({ ok: false, error: "full" }, 429);
      await store.set(`${room}/${id}_${enc(name)}_${a}_${b}`, "1");
      return json({ ok: true, name, a, b });
    }

    return json({ ok: false, error: "method" }, 405);
  } catch (err) {
    return json({ ok: false, error: "server", detail: String(err && err.message || err) }, 500);
  }
};

export const config = { path: "/api/scores" };
