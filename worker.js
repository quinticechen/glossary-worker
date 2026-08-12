/**
 * Underwriting Glossary sync backend.
 *
 * Endpoints (all require header  x-app-key: <APP_KEY>)
 *   GET  /cards?since=ISO   卡片：Notion Glossary 有異動的，或 since 空白時給完整快照
 *   GET  /state             練習狀態：{ state: { term: {...} } }
 *   POST /state             上傳 {state, log}；狀態以 term 為鍵、比 t 取新，log 追加
 *   GET  /export.csv        練習狀態匯出
 *   GET  /log.csv?days=30   練習明細匯出
 *
 * Cron（每天一次）
 *   1. 重抓整份 Glossary 存進 KV，讓 /cards 秒回
 *   2. 把當天有變動的卡片狀態寫回 Notion 的 Card State
 *   3. 在 Notion 的 Review Log 寫一列當日摘要
 */

const NV = "2022-06-28";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-app-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });
const csv = (t, name) =>
  new Response("\ufeff" + t, {
    headers: { "content-type": "text/csv;charset=utf-8", "content-disposition": `attachment; filename="${name}"`, ...CORS },
  });

/* ---------- Notion ---------- */
async function notion(env, path, init = {}) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      "notion-version": NV,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`notion ${r.status} ${await r.text()}`);
  return r.json();
}
const txt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text).join("").trim();

function toCard(page) {
  const p = page.properties;
  const sec = p.section?.select?.name || "A";
  return {
    t: txt(p.term),
    f: txt(p.full),
    p: txt(p.pos),
    c: txt(p.pattern),
    e: txt(p.example),
    z: txt(p.chinese),
    m: txt(p.meaning),
    n: txt(p.note),
    s: sec.trim()[0],
    x: (p.trap?.select?.name || "No") === "Yes" ? 1 : 0,
  };
}

async function queryAll(env, dbId, filter) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const d = await notion(env, `/databases/${dbId}/query`, { method: "POST", body: JSON.stringify(body) });
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}

async function fetchCards(env, since) {
  const filter = since
    ? { property: "Last edited time", last_edited_time: { on_or_after: since } }
    : null;
  const pages = await queryAll(env, env.GLOSSARY_DB, filter);
  return pages.map(toCard).filter((c) => c.t);
}

/* ---------- state ---------- */
async function readState(env) {
  return (await env.GLOSSARY.get("state", "json")) || {};
}
async function writeState(env, state) {
  await env.GLOSSARY.put("state", JSON.stringify(state));
}
function mergeState(base, incoming) {
  const dirty = [];
  for (const k of Object.keys(incoming || {})) {
    const a = base[k], b = incoming[k];
    if (!a || (b.t || 0) > (a.t || 0)) { base[k] = b; dirty.push(k); }
  }
  return dirty;
}
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------- routes ---------- */
async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // 靜態資源掛好的話，"/" 會先被 assets 接走，根本不會進到這裡。
  // 走到這裡就代表 wrangler.toml 少了 [assets]，或 public/index.html 不存在。
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>glossary-sync</title>
<body style="font-family:system-ui;max-width:34em;margin:12vh auto;padding:0 6vw;line-height:1.7;color:#16181A">
<h1 style="font-size:20px">Worker 活著，但 App 還沒上傳</h1>
<p>API 端點正常運作，只是找不到靜態資源。請確認：</p>
<ol>
<li><code>glossary-worker/public/index.html</code> 這個檔案存在</li>
<li><code>wrangler.toml</code> 裡有這兩行：<br><code>[assets]</code><br><code>directory = "./public"</code></li>
<li>重新執行 <code>npx wrangler deploy</code>，輸出的 bindings 應該要出現 Assets 一行</li>
</ol>
<p style="color:#4A5560;font-size:14px">健康檢查：<a href="/health">/health</a></p>`,
      { status: 200, headers: { "content-type": "text/html;charset=utf-8", ...CORS } }
    );
  }
  if (url.pathname === "/health") {
    return json({
      ok: true,
      kv: !!env.GLOSSARY,
      vars: { glossary: !!env.GLOSSARY_DB, state: !!env.STATE_DB, log: !!env.LOG_DB },
      secrets: { notion: !!env.NOTION_TOKEN, appKey: !!env.APP_KEY },
      note: "全部 true 才算設定完整。assets 是否掛好請直接看根目錄 /。",
    });
  }

  if (req.headers.get("x-app-key") !== env.APP_KEY) return json({ error: "bad key" }, 401);

  if (url.pathname === "/cards" && req.method === "GET") {
    const since = url.searchParams.get("since") || "";
    if (!since) {
      const cached = await env.GLOSSARY.get("cards", "json");
      if (cached) return json({ cards: cached.cards, now: cached.now, cached: true });
    }
    const cards = await fetchCards(env, since);
    const now = new Date().toISOString();
    if (!since) await env.GLOSSARY.put("cards", JSON.stringify({ cards, now }));
    return json({ cards, now });
  }

  if (url.pathname === "/state" && req.method === "GET") {
    return json({ state: await readState(env) });
  }

  if (url.pathname === "/state" && req.method === "POST") {
    const body = await req.json();
    const state = await readState(env);
    const dirty = mergeState(state, body.state);
    await writeState(env, state);

    if (dirty.length) {
      const pend = new Set((await env.GLOSSARY.get("dirty", "json")) || []);
      dirty.forEach((d) => pend.add(d));
      await env.GLOSSARY.put("dirty", JSON.stringify([...pend]));
    }
    if (body.log?.length) {
      const day = dayKey(Date.now());
      const key = "log:" + day;
      const prev = (await env.GLOSSARY.get(key, "json")) || [];
      await env.GLOSSARY.put(key, JSON.stringify(prev.concat(body.log)));
    }
    return json({ ok: true, merged: dirty.length, cards: Object.keys(state).length });
  }

  if (url.pathname === "/export.csv") {
    const state = await readState(env);
    const rows = [["term", "stage", "box", "due", "last_reviewed", "reviews", "approvals", "lapses", "mastered"]];
    for (const [k, r] of Object.entries(state))
      rows.push([k, r.st, r.b, new Date(r.due).toISOString(), r.t ? new Date(r.t).toISOString() : "",
        r.seen, r.ok, r.lapse || 0, r.st === 3 && r.b >= 4 ? "Yes" : "No"]);
    return csv(rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"), "card-state.csv");
  }

  if (url.pathname === "/log.csv") {
    const days = Math.min(180, +(url.searchParams.get("days") || 30));
    const rows = [["term", "reviewed_at", "grade", "mode", "elapsed_ms", "stage_before", "scored"]];
    for (let i = 0; i < days; i++) {
      const d = dayKey(Date.now() - i * 86400000);
      const entries = (await env.GLOSSARY.get("log:" + d, "json")) || [];
      for (const [term, min, g, mode, ds, stage, sc] of entries)
        rows.push([term, new Date(min * 60000).toISOString(), ["decline", "refer", "approve"][g], mode, ds * 100, stage, sc]);
    }
    return csv(rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"), "review-log.csv");
  }

  return json({ error: "not found" }, 404);
}

/* ---------- cron ---------- */
async function pageIdMap(env) {
  let map = await env.GLOSSARY.get("statePages", "json");
  if (map) return map;
  map = {};
  const pages = await queryAll(env, env.STATE_DB);
  pages.forEach((p) => { const t = txt(p.properties.term); if (t) map[t.toLowerCase()] = p.id; });
  await env.GLOSSARY.put("statePages", JSON.stringify(map));
  return map;
}

async function pushToNotion(env) {
  const dirty = (await env.GLOSSARY.get("dirty", "json")) || [];
  if (!dirty.length) return 0;
  const state = await readState(env);
  const map = await pageIdMap(env);
  let done = 0;
  for (const key of dirty.slice(0, 120)) {
    const r = state[key];
    if (!r) continue;
    const props = {
      stage: { number: r.st },
      box: { number: r.b },
      due: { date: { start: new Date(r.due).toISOString() } },
      last_reviewed: { date: { start: new Date(r.t || Date.now()).toISOString() } },
      reviews: { number: r.seen },
      approvals: { number: r.ok },
      lapses: { number: r.lapse || 0 },
      mastered: { checkbox: r.st === 3 && r.b >= 4 },
    };
    try {
      if (map[key]) {
        await notion(env, `/pages/${map[key]}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
      } else {
        const created = await notion(env, "/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { database_id: env.STATE_DB },
            properties: { term: { title: [{ text: { content: key } }] }, ...props },
          }),
        });
        map[key] = created.id;
      }
      done++;
    } catch (e) { /* 單張失敗不要中斷整批 */ }
    await new Promise((r) => setTimeout(r, 340)); // Notion 限速 3 req/s
  }
  await env.GLOSSARY.put("statePages", JSON.stringify(map));
  await env.GLOSSARY.put("dirty", JSON.stringify(dirty.slice(120)));
  return done;
}

async function dailySummary(env) {
  const day = dayKey(Date.now() - 3600000);
  const entries = (await env.GLOSSARY.get("log:" + day, "json")) || [];
  if (!entries.length) return;
  const state = await readState(env);
  const approve = entries.filter((e) => e[2] === 2).length;
  const byMode = {};
  entries.forEach((e) => { byMode[e[3]] = (byMode[e[3]] || 0) + 1; });
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: env.LOG_DB },
      properties: {
        date: { title: [{ text: { content: day } }] },
        reviewed: { number: entries.length },
        approve_rate: { number: Math.round((approve / entries.length) * 100) / 100 },
        mastered_total: { number: Object.values(state).filter((r) => r.st === 3 && r.b >= 4).length },
        median_seconds: { number: median(entries.map((e) => e[4])) / 10 },
        breakdown: { rich_text: [{ text: { content: Object.entries(byMode).map(([k, v]) => `${k}:${v}`).join("  ") } }] },
      },
    }),
  });
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil((async () => {
      const cards = await fetchCards(env, "");
      await env.GLOSSARY.put("cards", JSON.stringify({ cards, now: new Date().toISOString() }));
      await pushToNotion(env);
      try { await dailySummary(env); } catch (e) {}
    })());
  },
};