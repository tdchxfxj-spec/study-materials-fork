interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  UPSTREAM_DEFAULT?: string;
}
type Session = { origin: string; token: string; user: unknown; hosts: string[]; lineHosts?: string[] };
const DEFAULT_ORIGIN = "https://huangguoai.com";
const FIXED = [
  { name: "固定线路 1", url: "https://huangguoai.com" },
  { name: "固定线路 2", url: "https://huangguoai.ai" },
];
const COOKIE = "__Host-hghub_sid";
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const error = (message: string, status = 400) => json({ error: message }, status);
const safeOrigin = (raw: string, mirrorHosts: string[] = []) => {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || !["huangguoai.com", "huangguoai.ai", ...mirrorHosts].includes(u.hostname)) {
    throw new Error("不允许使用该数据源线路");
  }
  return u.origin;
};
const validPublicHttps = (raw: string) => {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443") throw new Error("媒体地址无效");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) throw new Error("媒体主机不允许访问");
  return u;
};
const readBody = async (request: Request) => {
  try { return await request.json() as Record<string, unknown>; } catch { return {}; }
};
const getSid = (request: Request) => request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
const cookie = (sid: string) => `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
async function sessionStub(env: Env, sid: string) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sid));
}
async function getSession(env: Env, sid: string): Promise<Session> {
  const r = await (await sessionStub(env, sid)).fetch("https://session/state");
  if (!r.ok) return { origin: DEFAULT_ORIGIN, token: "", user: null, hosts: [] };
  return await r.json() as Session;
}
async function putSession(env: Env, sid: string, value: Session) {
  await (await sessionStub(env, sid)).fetch("https://session/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}
function collectMediaHosts(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || out.size >= 50 || value == null) return out;
  if (Array.isArray(value)) { for (const v of value.slice(0, 500)) collectMediaHosts(v, out, depth + 1); return out; }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(cover|cover_url|image|image_url|poster|thumb|thumbnail|url|src|video_url|video_url_hevc|main|hevc|preview|stream)$/i.test(key) && typeof v === "string" && /^https:\/\//i.test(v)) {
        try { out.add(validPublicHttps(v).hostname); } catch { /* ignore untrusted URL */ }
      } else if (typeof v === "object") collectMediaHosts(v, out, depth + 1);
    }
  }
  return out;
}
async function upstream(env: Env, session: Session, method: string, path: string, body?: unknown) {
  const target = new URL(path, session.origin);
  if (target.origin !== session.origin) throw new Error("上游地址无效");
  const headers = new Headers({ accept: "application/json", "user-agent": "HGhub-Web/1.0" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (session.token) headers.set("authorization", `Bearer ${session.token}`);
  const response = await fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error("上游返回了无效 JSON"); }
  return data;
}
const int = (v: unknown, fallback: number) => Math.max(1, Math.min(200, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback));
async function command(request: Request, env: Env, sid: string, cmd: string) {
  const args = await readBody(request);
  const s = await getSession(env, sid);
  let result: unknown;
  let method = "GET", path = "", body: unknown = undefined;
  switch (cmd) {
    case "app_boot": result = { user: s.token ? s.user : null, logged_in: !!s.token, base: s.origin, strict_security: true, cli_relaxed: false }; break;
    case "security_set": result = true; break;
    case "debug_log": result = null; break;
    case "net_diag": result = { mode: "cloudflare-worker", ok: true }; break;
    case "cache_clear": result = null; break;\n    case "playback_log_status": result = { enabled: false, path: null, error: null }; break;\n    case "playback_log_set": result = { enabled: false, path: null, error: null }; break;\n    case "playback_log_write": result = null; break;\n    case "playback_log_read": result = ""; break;
    case "open_url": result = null; break;\n    case "set_orientation": result = null; break;\n    case "plugin:app|exit": result = null; break;
    case "line_state": result = { base: s.origin, default: DEFAULT_ORIGIN, fixed: FIXED }; break;
    case "line_set": {
      const next = safeOrigin(String(args.url ?? ""));
      s.origin = next; s.token = ""; s.user = null; await putSession(env, sid, s); result = next; break;
    }
    case "line_mirrors": { const data = await mirrors(); s.lineHosts = data.items.map(x => x.host); await putSession(env, sid, s); result = data; break; }
    case "line_probe": {
      const urls = Array.isArray(args.urls) ? args.urls.slice(0, 60) : [];
      result = await Promise.all(urls.map(async raw => {
        try { const u = safeOrigin(String(raw), s.lineHosts ?? []); const start = Date.now(); const r = await fetch(u + "/", { method: "HEAD", redirect: "error" }); return { url: u, ok: r.status < 400, status: r.status, ms: Date.now() - start }; }
        catch (e) { return { url: String(raw), ok: false, ms: 0, error: String(e) }; }
      })); break;
    }
    case "api_login":
    case "api_register": {
      method = "POST";
      path = cmd === "api_login" ? "/api/account/loginByPassword" : "/api/account/registerByPassword";
      body = cmd === "api_login"
        ? { username: args.username, password: args.password }
        : { username: args.username, password: args.password, confirm_password: args.password, ...(String(args.email ?? "").trim() ? { email: args.email } : {}) };
      const data = await upstream(env, { ...s, token: "" }, method, path, body) as Record<string, unknown>;
      if (typeof data.token !== "string" || !data.token) throw new Error("登录/注册返回缺少 token");
      s.token = data.token; s.user = data.user ?? null;
      for (const h of collectMediaHosts(data)) s.hosts = [...new Set([...s.hosts, h])].slice(-80);
      await putSession(env, sid, s); result = { user: s.user }; break;
    }
    case "api_logout":
      try { await upstream(env, s, "POST", "/api/account/logout"); } catch { /* local logout still succeeds */ }
      s.token = ""; s.user = null; await putSession(env, sid, s); result = { ok: true }; break;
    case "api_me":
      result = await upstream(env, s, "GET", "/api/account/me");
      if (s.token) { s.user = result; await putSession(env, sid, s); } break;
    case "api_feed": path = `/api/videos?page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "api_category": path = `/api/videos/category/${encodeURIComponent(String(args.cate ?? ""))}?page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "api_rank": path = `/api/ranks/${["recommend","potential"].includes(String(args.kind)) ? args.kind : "hot"}`; break;
    case "api_search": path = `/api/search?q=${encodeURIComponent(String(args.q ?? ""))}&page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "api_posts": path = `/api/posts?page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "api_post": path = `/api/posts/${int(args.id,1)}`; break;
    case "api_video": path = `/api/videos/${int(args.id,1)}`; break;
    case "api_play": {
      const id = int(args.id,1), ep = int(args.ep,1);
      try {
        const primary = await upstream(env, s, "POST", `/api/videos/${id}/episodes/${ep}/playback`, {});
        const normalized = normalizePlay(primary);
        if (hasPlayUrl(normalized)) { result = normalized; break; }
        const legacy = normalizePlay(await upstream(env, s, "GET", `/api/videos/${id}/play?ep=${ep}&page_texts=0`));
        result = hasPlayUrl(legacy) ? legacy : normalized; break;
      } catch (e) {
        result = normalizePlay(await upstream(env, s, "GET", `/api/videos/${id}/play?ep=${ep}&page_texts=0`));
        if (!hasPlayUrl(result)) throw e;
      }
      break;
    }
    case "api_comments": path = `/api/videos/${int(args.id,1)}/comments?ep=${int(args.ep,1)}&page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "api_comment_send": {
      if (!s.token) throw new Error("请先登录");
      method = "POST"; body = { text: String(args.text ?? "") };
      const rid = Number(args.replyId);
      path = rid > 0 ? `/api/videos/${int(args.id,1)}/comments` : `/api/videos/${int(args.id,1)}/comments?ep=${int(args.ep,1)}`;
      if (rid > 0) (body as Record<string, unknown>).reply_id = rid;
      break;
    }
    case "api_like": case "api_collect": case "api_follow": case "api_post_like": case "api_post_collect": {
      if (!s.token) throw new Error("请先登录");
      method = args.on ? "POST" : "DELETE";
      path = cmd === "api_like" ? `/api/videos/${int(args.id,1)}/like?ep=${int(args.ep,1)}`
        : cmd === "api_collect" ? `/api/videos/${int(args.id,1)}/collect`
        : cmd === "api_follow" ? `/api/users/${int(args.uid,1)}/follow`
        : cmd === "api_post_like" ? `/api/posts/${int(args.id,1)}/like`
        : `/api/posts/${int(args.id,1)}/collect`;
      break;
    }
    case "api_post_comments": path = `/api/posts/${int(args.id,1)}/comments?page=${int(args.page,1)}&size=${int(args.size,20)}`; break;
    case "check_update": {
      const r = await fetch("https://api.github.com/repos/Minireel/HGhub/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": "HGhub-Web" } });
      if (r.status === 404) { result = { current: "web", latest: "", has_update: false, url: "https://github.com/Minireel/HGhub/releases" }; break; }
      if (!r.ok) throw new Error(`GitHub 返回 HTTP ${r.status}`);
      const v = await r.json() as Record<string, unknown>; const tag = String(v.tag_name ?? "");
      result = { current: "web", latest: tag.replace(/^[vV]/,""), tag, has_update: !!tag, url: v.html_url ?? "https://github.com/Minireel/HGhub/releases", name: v.name ?? "", published_at: v.published_at ?? "", notes: String(v.body ?? "").slice(0,800) }; break;
    }
    default: throw new Error(`不支持的网页命令：${cmd}`);
  }
  if (path) {
    if (["api_like","api_collect","api_follow","api_comment_send","api_post_like","api_post_collect"].includes(cmd) && !s.token) throw new Error("请先登录");
    result = await upstream(env, s, method, path, body);
  }
  for (const h of collectMediaHosts(result)) s.hosts = [...new Set([...s.hosts, h])].slice(-80);
  await putSession(env, sid, s);
  return json(result);
}
function normalizePlay(v: unknown) {
  if (!v || typeof v !== "object") return v;
  const x = v as Record<string, unknown>, streams = x.streams as Record<string, unknown> | undefined;
  return { ...x, video_url: x.video_url || streams?.main || "", video_url_hevc: x.video_url_hevc || streams?.hevc || "" };
}
function hasPlayUrl(v: unknown) { return !!(v && typeof v === "object" && typeof (v as Record<string,unknown>).video_url === "string" && (v as Record<string,unknown>).video_url); }
async function mirrors() {
  const page = await fetch("https://huangguoai.pages.dev/", { redirect: "error" });
  if (!page.ok) throw new Error("地址发布页暂不可用");
  const html = await page.text(); const script = html.match(/src="([^"]+\.js[^"]*)"/)?.[1] ?? "publish.js";
  const scriptUrl = new URL(script, "https://huangguoai.pages.dev/").toString();
  const js = await (await fetch(scriptUrl, { redirect: "error" })).text();
  const arr = (name: string) => {
    const m = js.match(new RegExp(`var\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : [];
  };
  const domains = arr("urls"), subs = arr("subdomains"), items: {url:string;host:string}[] = [];
  for (const domain of domains) for (const host of (subs.length ? subs.map(x=>`${x}.${domain.replace(/\/$/,"")}`) : [domain.replace(/\/$/,"")])) {
    if (!items.some(x=>x.host===host)) items.push({url:`https://${host}`,host});
    if (items.length >= 60) break;
  }
  if (!items.length) throw new Error("地址发布页里没有可用的镜像地址");
  return { source: "https://huangguoai.pages.dev/", script: scriptUrl, items };
}
async function media(request: Request, env: Env, sid: string, kind: "img"|"hls"|"seg") {
  const s = await getSession(env, sid), raw = new URL(request.url).searchParams.get("u");
  if (!raw) return error("missing u",400);
  let target: URL;
  try { target = validPublicHttps(raw); } catch(e) { return error(String(e),403); }
  if (!s.hosts.includes(target.hostname)) return error("媒体主机未获上游授权",403);
  const fetchMedia = async (u: URL): Promise<Response> => {
    if (!s.hosts.includes(u.hostname)) throw new Error("媒体重定向目标未获授权");
    const headers = new Headers();
    const range = request.headers.get("range"); if (range) headers.set("range",range);
    const r = await fetch(u, {headers, redirect:"manual"});
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get("location"); if (!loc) return r;
      const next = validPublicHttps(new URL(loc,u).toString());
      return fetchMedia(next);
    }
    return r;
  };
  try {
    const r = await fetchMedia(target);
    if (!r.ok) return new Response(await r.arrayBuffer(), {status:r.status,headers:r.headers});
    if (kind === "img") {
      const bytes = new Uint8Array(await r.arrayBuffer());
      const isImage = bytes[0]===0xff && bytes[1]===0xd8 || bytes[0]===0x89 && bytes[1]===0x50 || new TextDecoder().decode(bytes.slice(0,4))==="RIFF";
      let out = bytes, type = r.headers.get("content-type") || "image/jpeg";
      if (!isImage) {
        const key = new TextEncoder().encode("f5d965df75336270"), iv = new TextEncoder().encode("97b60394abc2fbe1");
        const cryptoKey = await crypto.subtle.importKey("raw",key,{name:"AES-CBC"},false,["decrypt"]);
        out = new Uint8Array(await crypto.subtle.decrypt({name:"AES-CBC",iv},cryptoKey,bytes));
        type = out[0]===0xff && out[1]===0xd8 ? "image/jpeg" : type;
      }
      return new Response(out,{headers:{"content-type":type,"cache-control":"public,max-age=86400","x-content-type-options":"nosniff"}});
    }
    const contentType = r.headers.get("content-type") || "";
    if (kind === "hls" || contentType.toLowerCase().includes("mpegurl")) {
      const text = await r.text();
      if (!text.trimStart().replace(/^\uFEFF/,"").startsWith("#EXTM3U")) return error("响应不是 HLS 播放列表",502);
      return new Response(rewritePlaylist(target,text),{headers:{"content-type":"application/vnd.apple.mpegurl","cache-control":"no-store","x-content-type-options":"nosniff"}});
    }
    return new Response(r.body,{status:r.status,headers:{
      "content-type":contentType || "application/octet-stream",
      "cache-control":"public,max-age=3600",
      "accept-ranges":r.headers.get("accept-ranges") || "bytes",
      "content-length":r.headers.get("content-length") || ""
    }});
  } catch(e) { return error(String(e),502); }
}
function rewritePlaylist(base: URL, text: string) {
  const encode = (u:string) => `/__media/seg?u=${encodeURIComponent(new URL(u,base).toString())}`;
  return text.replace(/^\uFEFF/,"").split(/\r?\n/).map(line => {
    if (!line) return "";
    if (line.startsWith("#EXT-X-CONTENT-STEERING:")) return "";
    if (line.startsWith("#EXT-X-DATERANGE:")) return line.replace(/,?[^,=]*(?:URI|ASSET)[^,=]*="[^"]*"/gi,"");
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g,(_m,u)=>`URI="${encode(u)}"`);
    return encode(line.trim());
  }).join("\n");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__api/") || url.pathname.startsWith("/__media/")) {
      const origin = request.headers.get("origin");
      if ((url.pathname.startsWith("/__api/") && origin !== url.origin) || (origin && origin !== url.origin)) return error("origin denied",403);
      let sid = getSid(request), isNew = false;
      if (!sid || !/^[a-f0-9-]{36}$/i.test(sid)) { sid = crypto.randomUUID(); isNew = true; }
      const path = url.pathname;
      let response: Response;
      if (path.startsWith("/__api/command/") && request.method === "POST") {
        response = await command(request,env,sid,decodeURIComponent(path.slice("/__api/command/".length))).catch(e=>error(e instanceof Error?e.message:String(e),502));
      } else if (path === "/__media/img" || path === "/__media/hls" || path === "/__media/seg") {
        response = await media(request,env,sid,path.endsWith("/img")?"img":path.endsWith("/hls")?"hls":"seg");
      } else response = error("not found",404);
      const headers = new Headers(response.headers);
      if (isNew) headers.append("set-cookie",cookie(sid));
      headers.set("vary","cookie");
      return new Response(response.body,{status:response.status,headers});
    }
    return env.ASSETS.fetch(request);
  }
};
export class SessionDO {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    if (request.method === "GET") return Response.json((await this.state.storage.get<Session>("session")) ?? {origin:DEFAULT_ORIGIN,token:"",user:null,hosts:[]});
    if (request.method === "PUT") { await this.state.storage.put("session", await request.json()); return new Response(null,{status:204}); }
    if (request.method === "DELETE") { await this.state.storage.delete("session"); return new Response(null,{status:204}); }
    return new Response("method not allowed",{status:405});
  }
}
