const MIME = {
  ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",
  ".webp":"image/webp",".avif":"image/avif",".svg":"image/svg+xml",".json":"application/json",
  ".zip":"application/zip",".webp":"image/webp"
};
const MAX_BYTES = 8 * 1024 * 1024;
const enc = s => new TextEncoder().encode(s);
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data), {
  status, headers: {"content-type":"application/json;charset=utf-8","cache-control":"no-store",...headers}
});
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function toB64(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i=0;i<bytes.length;i+=chunk) out += String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(out);
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function sign(payload, secret) {
  const key = await crypto.subtle.importKey("raw",enc(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return b64url(await crypto.subtle.sign("HMAC",key,enc(payload)));
}
function cookie(value,maxAge=86400) {
  return `asset_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
async function valid(req,env) {
  const m=(req.headers.get("Cookie")||"").match(/(?:^|;\s*)asset_session=([^;]+)/);
  if(!m || !env.SESSION_SECRET) return false;
  const [p,s]=m[1].split(".");
  if(!p||!s) return false;
  const expected=await sign(p,env.SESSION_SECRET);
  if(expected!==s) return false;
  try {
    const data=JSON.parse(atob(p.replace(/-/g,"+").replace(/_/g,"/")));
    return data.exp>Date.now();
  } catch { return false; }
}
function config(env,scope) {
  const repo=scope==="private"?env.PRIVATE_REPO:env.PUBLIC_REPO;
  if(!env.GITHUB_OWNER||!env.GITHUB_TOKEN||!repo) throw Error("Worker 环境变量缺失：请检查 GITHUB_OWNER、GITHUB_TOKEN 和素材仓库名");
  return {owner:env.GITHUB_OWNER,repo,branch:env.GITHUB_BRANCH||"main"};
}
async function gh(env,scope,path,init={}) {
  const c=config(env,scope);
  const r=await fetch("https://api.github.com"+path,{
    ...init,headers:{
      "Authorization":"Bearer "+env.GITHUB_TOKEN,
      "Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"Personal-Asset-Hub",
      ...(init.headers||{})
    }
  });
  let d; try { d=await r.json(); } catch { d={}; }
  if(!r.ok) throw Error(d.message||`GitHub API 错误 ${r.status}`);
  return d;
}
function repoPath(scope,path) {
  const c = path.split("/").map(encodeURIComponent).join("/");
  return `/repos/${scope.owner}/${scope.repo}/contents/${c}`;
}
function cleanPart(s) {
  return String(s||"未分类").normalize("NFC").replace(/[\\/:*?"<>|#%]/g,"_").replace(/[\u0000-\u001f]/g,"").trim().slice(0,70)||"未分类";
}
function cleanName(s) {
  return String(s||"file").normalize("NFC").replace(/[\\/:*?"<>|#%]/g,"_").replace(/[\u0000-\u001f]/g,"").trim().slice(0,160)||"file";
}
function mimeFor(name) {
  const i=name.lastIndexOf(".");
  return MIME[i>=0?name.slice(i).toLowerCase():""]||"application/octet-stream";
}
async function getTree(env,scope) {
  const c=config(env,scope);
  const branch=await gh(env,scope,`/repos/${c.owner}/${c.repo}/branches/${encodeURIComponent(c.branch)}`);
  const tree=await gh(env,scope,`/repos/${c.owner}/${c.repo}/git/trees/${branch.commit.commit.tree.sha}?recursive=1`);
  if(tree.truncated) throw Error("仓库文件树过大，GitHub 返回了截断结果；请考虑迁移到 R2/S3");
  return (tree.tree||[]).filter(x=>x.type==="blob"&&x.path.startsWith("assets/"));
}
async function listFiles(env,scope) {
  const c=config(env,scope), tree=await getTree(env,scope);
  return tree.map(x=>{
    const parts=x.path.split("/");
    const category=decodeURIComponent(parts[1]||"未分类");
    const name=parts.slice(2).join("/");
    const url=scope==="public"
      ? `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${encodeURIComponent(c.branch)}/${x.path.split("/").map(encodeURIComponent).join("/")}`
      : null;
    return {scope,path:x.path,name,category,size:x.size||0,type:mimeFor(name),sha:x.sha,url};
  });
}
async function getFileBytes(env,scope,path) {
  const c=config(env,scope);
  const d=await gh(env,scope,repoPath(c,path)+`?ref=${encodeURIComponent(c.branch)}`);
  if(!d.content) throw Error("GitHub 未返回文件内容");
  return fromB64(d.content.replace(/\n/g,""));
}
async function putFile(env,scope,path,bytes,message) {
  const c=config(env,scope);
  const apiPath=repoPath(c,path);
  let sha;
  try { const old=await gh(env,scope,apiPath+`?ref=${encodeURIComponent(c.branch)}`); sha=old.sha; }
  catch(e) { if(!String(e.message).includes("Not Found")) throw e; }
  const body={message,content:toB64(bytes),branch:c.branch};
  if(sha) body.sha=sha;
  return gh(env,scope,apiPath,{method:"PUT",body:JSON.stringify(body)});
}
async function deleteFile(env,scope,path) {
  const c=config(env,scope), apiPath=repoPath(c,path);
  const old=await gh(env,scope,apiPath+`?ref=${encodeURIComponent(c.branch)}`);
  return gh(env,scope,apiPath,{method:"DELETE",body:JSON.stringify({message:"Delete asset "+path,sha:old.sha,branch:c.branch})});
}
async function handle(req,env) {
  const u=new URL(req.url), p=u.pathname;
  if(req.method==="GET"&&p==="/") return new Response(INDEX,{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store"}});
  if(p==="/api/login"&&req.method==="POST") {
    const b=await req.json();
    if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET) return json({error:"尚未设置 ADMIN_PASSWORD 或 SESSION_SECRET"},500);
    if(b.password!==env.ADMIN_PASSWORD) return json({error:"管理员密码不正确"},401);
    const payload=b64url(enc(JSON.stringify({exp:Date.now()+12*60*60*1000})));
    return json({ok:true},200,{"set-cookie":cookie(payload+"."+await sign(payload,env.SESSION_SECRET),43200)});
  }
  if(p==="/api/logout"&&req.method==="POST") return json({ok:true},200,{"set-cookie":cookie("",0)});
  if(p==="/api/me"&&req.method==="GET") return valid(req,env)?json({ok:true}):json({error:"请先登录"},401);
  if(!await valid(req,env)) return json({error:"未登录或登录已过期"},401);
  if(p==="/api/files"&&req.method==="GET") {
    const [pub,priv]=await Promise.all([listFiles(env,"public"),listFiles(env,"private")]);
    return json({files:[...pub,...priv]});
  }
  if(p==="/api/upload"&&req.method==="POST") {
    const form=await req.formData();
    const file=form.get("file"), scope=form.get("scope")==="private"?"private":"public";
    const category=cleanPart(form.get("category")), name=cleanName(file?.name);
    if(!(file instanceof File)) return json({error:"没有收到文件"},400);
    if(file.size===0) return json({error:"文件为空"},400);
    if(file.size>MAX_BYTES) return json({error:`单文件超过 ${MAX_BYTES/1024/1024}MB 限制；请缩小文件或等待后续 R2/S3 版本`},413);
    const bytes=new Uint8Array(await file.arrayBuffer());
    const hash=await sha256(bytes);
    const path=`assets/${encodeURIComponent(category)}/${Date.now()}_${name}`;
    await putFile(env,scope,path,bytes,"Upload "+name);
    const check=await getFileBytes(env,scope,path);
    const verified=await sha256(check);
    if(hash!==verified) {
      try { await deleteFile(env,scope,path); } catch {}
      throw Error("上传后 SHA-256 校验失败，文件已回滚删除");
    }
    const c=config(env,scope);
    const publicUrl=scope==="public"
      ? `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${encodeURIComponent(c.branch)}/${path.split("/").map(encodeURIComponent).join("/")}`
      : null;
    return json({ok:true,path,scope,sha256:hash,url:publicUrl});
  }
  if(p==="/api/download"&&req.method==="GET") {
    const scope=u.searchParams.get("scope")==="private"?"private":"public";
    const path=u.searchParams.get("path")||"";
    if(!path.startsWith("assets/")||path.includes("..")) return json({error:"文件路径不合法"},400);
    const bytes=await getFileBytes(env,scope,path);
    const name=decodeURIComponent(path.split("/").pop()||"download");
    return new Response(bytes,{headers:{
      "content-type":mimeFor(name),"content-length":String(bytes.length),
      "content-disposition":`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control":"no-store","x-content-type-options":"nosniff"
    }});
  }
  if(p==="/api/files"&&req.method==="DELETE") {
    const scope=u.searchParams.get("scope")==="private"?"private":"public";
    const path=u.searchParams.get("path")||"";
    if(!path.startsWith("assets/")||path.includes("..")) return json({error:"文件路径不合法"},400);
    await deleteFile(env,scope,path); return json({ok:true});
  }
  if(p==="/api/move"&&req.method==="POST") {
    const b=await req.json(), scope=b.scope==="private"?"private":"public";
    const oldPath=String(b.path||"");
    if(!oldPath.startsWith("assets/")||oldPath.includes("..")) return json({error:"源路径不合法"},400);
    const bytes=await getFileBytes(env,scope,oldPath), before=await sha256(bytes);
    const newCategory=cleanPart(b.category), newName=cleanName(b.name||oldPath.split("/").pop().replace(/^\d+_/,""));
    const newPath=`assets/${encodeURIComponent(newCategory)}/${Date.now()}_${newName}`;
    const c=config(env,scope);
    const exists=await listFiles(env,scope);
    if(exists.some(x=>x.path===newPath)) return json({error:"目标文件已存在，请重试"},409);
    await putFile(env,scope,newPath,bytes,"Move/rename asset");
    const after=await sha256(await getFileBytes(env,scope,newPath));
    if(before!==after) { try { await deleteFile(env,scope,newPath); } catch {} throw Error("目标校验失败，源文件保留"); }
    await deleteFile(env,scope,oldPath);
    return json({ok:true,path:newPath,sha256:after});
  }
  return json({error:"Not found"},404);
}
const INDEX = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#172033"><title>个人素材库</title><style>
:root{color-scheme:light;--bg:#f4f6fb;--card:#fff;--ink:#20283a;--muted:#748096;--line:#e6eaf1;--blue:#4263eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px system-ui,-apple-system,"Segoe UI",sans-serif}button,input,select{font:inherit}button{border:0;border-radius:11px;padding:10px 13px;background:var(--blue);color:white;font-weight:650;cursor:pointer}button.secondary{background:#edf0f6;color:#30394b}button.danger{background:#fff0f0;color:#b42318}.wrap{max-width:1100px;margin:auto;padding:18px 15px 60px}.top{background:#172033;color:white;padding:17px}.topin{max-width:1100px;margin:auto;display:flex;justify-content:space-between;align-items:center}.brand{font-size:19px;font-weight:800}.muted{color:var(--muted);font-size:12px}.panel{background:white;border:1px solid var(--line);border-radius:16px;padding:16px;margin:13px 0}.hidden{display:none!important}.field{display:grid;gap:6px;margin:10px 0}.field input,.field select,.tools input,.tools select{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;background:white}.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.row>*{flex:1}.tools{display:grid;grid-template-columns:1fr 180px auto;gap:9px;margin:15px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:12px}.item{background:white;border:1px solid var(--line);border-radius:14px;overflow:hidden}.thumb{height:140px;background:#eef1f5;display:flex;align-items:center;justify-content:center}.thumb img{width:100%;height:100%;object-fit:contain}.body{padding:10px}.fname{font-size:13px;font-weight:700;overflow-wrap:anywhere}.tag{font-size:11px;background:#edf1ff;color:#4257a0;padding:4px 7px;border-radius:20px;display:inline-block;margin:6px 0}.actions{display:flex;gap:6px;margin-top:8px}.actions button{flex:1;padding:8px 4px;font-size:12px}.notice{padding:11px;border-radius:10px;background:#eef4ff;color:#344c8a;margin:10px 0;font-size:13px}.error{background:#fff0f0;color:#a52626}.success{background:#edfbf2;color:#176b39}.stats{display:flex;gap:10px}.stat{background:white;border:1px solid var(--line);border-radius:13px;padding:12px;flex:1}.num{font-size:22px;font-weight:800}.section{margin:20px 0 8px;font-weight:750}.modal{position:fixed;inset:0;background:#10182899;display:flex;align-items:center;justify-content:center;padding:15px}.dialog{background:white;border-radius:17px;padding:18px;width:min(560px,100%);max-height:90vh;overflow:auto}.right{margin-left:auto}@media(max-width:600px){.tools{grid-template-columns:1fr 1fr}.tools input{grid-column:1/-1}.stats{gap:6px}.stat{padding:9px}.num{font-size:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><header class="top"><div class="topin"><div><div class="brand">✦ 个人素材库</div><div class="muted" style="color:#b9c4d8">Personal Asset Hub · 双仓库安全版</div></div><span id="status">未登录</span></div></header><main class="wrap">
<section id="login" class="panel"><h2 style="margin-top:0">登录管理后台</h2><div class="field"><label>管理员密码</label><input id="password" type="password" autocomplete="current-password"></div><button id="loginBtn">登录</button><div id="loginMsg" class="notice hidden"></div></section>
<section id="app" class="hidden"><div class="stats"><div class="stat"><div class="num" id="total">0</div><div class="muted">文件总数</div></div><div class="stat"><div class="num" id="pub">0</div><div class="muted">公开素材</div></div><div class="stat"><div class="num" id="priv">0</div><div class="muted">私人素材</div></div></div>
<div class="section">上传素材</div><div class="panel"><div class="field"><label>存储位置</label><select id="scope"><option value="public">公开素材库（可生成直链）</option><option value="private">私人素材库（仅后台登录后下载）</option></select></div><div class="field"><label>分类</label><select id="category"><option>表情包</option><option>角色卡</option><option>卡面</option><option>背景图片</option><option>头像</option><option>其他</option></select></div><div class="field"><label>选择文件（支持多选）</label><input id="files" type="file" multiple></div><button id="uploadBtn">开始上传</button><div id="uploadMsg" class="notice hidden"></div><div id="progress" class="muted"></div></div>
<div class="section">素材列表</div><div class="tools"><input id="search" placeholder="搜索文件名…"><select id="filter"><option value="">全部分类</option><option>表情包</option><option>角色卡</option><option>卡面</option><option>背景图片</option><option>头像</option><option>其他</option></select><button class="secondary" id="refresh">刷新</button></div><div id="list" class="grid"><div class="muted">加载中…</div></div>
<div class="panel"><div class="row"><button class="secondary" id="export">导出文件清单</button><button class="secondary" id="logout">退出登录</button></div><p class="muted">原文件按字节上传和下载，不进行图片压缩或格式转换。当前 GitHub API 单文件上限设为 8MB；超出会明确提示。公开仓库内容任何人都可访问；私人文件只经登录后的 Worker 下载。</p></div></section></main>
<div id="modal" class="modal hidden"><div class="dialog"><div class="row"><strong id="modalTitle">文件详情</strong><button class="secondary right" id="close">关闭</button></div><div id="modalBody"></div></div></div>
<script>
const $=id=>document.getElementById(id);let files=[];
async function api(path,opts={}){const r=await fetch('/api'+path,{...opts});let d={};if((r.headers.get('content-type')||'').includes('application/json')){try{d=await r.json()}catch{}}if(!r.ok)throw Error(d.error||'请求失败 '+r.status);return d}
function show(el,s,error=false){el.textContent=s;el.className='notice '+(error?'error':'success')}
async function login(){try{await api('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('password').value})});$('login').classList.add('hidden');$('app').classList.remove('hidden');$('status').textContent='已登录';await refresh()}catch(e){show($('loginMsg'),e.message,true)}}
async function boot(){try{await api('/me');$('login').classList.add('hidden');$('app').classList.remove('hidden');$('status').textContent='已登录';await refresh()}catch{}}
function fmt(n){if(!n)return'0 B';let u=['B','KB','MB','GB'],i=Math.min(3,Math.floor(Math.log(n)/Math.log(1024)));return(n/1024**i).toFixed(i?1:0)+' '+u[i]}
async function refresh(){try{files=(await api('/files')).files||[];render()}catch(e){alert(e.message)}}
function render(){let q=$('search').value.toLowerCase(),cat=$('filter').value;let arr=files.filter(f=>(!cat||f.category===cat)&&f.name.toLowerCase().includes(q));$('total').textContent=files.length;$('pub').textContent=files.filter(f=>f.scope==='public').length;$('priv').textContent=files.filter(f=>f.scope==='private').length;$('list').innerHTML='';if(!arr.length){$('list').textContent='暂无符合条件的文件';return}for(const f of arr){let card=document.createElement('article');card.className='item';let thumb=document.createElement('div');thumb.className='thumb';if(f.type.startsWith('image/')){let im=document.createElement('img');im.src=f.scope==='public'?f.url:'/api/download?scope=private&path='+encodeURIComponent(f.path);im.loading='lazy';thumb.append(im)}else thumb.textContent='📄';let body=document.createElement('div');body.className='body';let name=document.createElement('div');name.className='fname';name.textContent=f.name;let tag=document.createElement('span');tag.className='tag';tag.textContent=(f.scope==='private'?'🔒 私人 · ':'🌐 公开 · ')+f.category;let size=document.createElement('div');size.className='muted';size.textContent=fmt(f.size);let actions=document.createElement('div');actions.className='actions';let detail=document.createElement('button');detail.textContent='管理';detail.onclick=()=>openDetail(f);let dl=document.createElement('button');dl.className='secondary';dl.textContent='下载';dl.onclick=()=>download(f);actions.append(detail,dl);body.append(name,tag,size,actions);card.append(thumb,body);$('list').append(card)}}
function download(f){location.href='/api/download?scope='+f.scope+'&path='+encodeURIComponent(f.path)}
function openDetail(f){$('modalTitle').textContent=f.name;$('modalBody').innerHTML='';let info=document.createElement('p');info.className='muted';info.textContent=(f.scope==='private'?'私人仓库':'公开仓库')+' · '+f.category+' · '+fmt(f.size);$('modalBody').append(info);if(f.url){let link=document.createElement('input');link.value=f.url;link.readOnly=true;link.style.width='100%';link.style.padding='10px';$('modalBody').append(link);let cp=document.createElement('button');cp.textContent='复制公开直链';cp.onclick=()=>navigator.clipboard.writeText(f.url);$('modalBody').append(cp)}let cat=document.createElement('input');cat.placeholder='新分类';cat.value=f.category;cat.style.width='100%';cat.style.padding='10px';cat.style.marginTop='10px';let nm=document.createElement('input');nm.placeholder='新文件名（不含路径）';nm.value=f.name.replace(/^\\d+_/,'');nm.style.width='100%';nm.style.padding='10px';nm.style.marginTop='8px';let save=document.createElement('button');save.textContent='重命名 / 移动分类';save.style.marginTop='10px';save.onclick=async()=>{try{await api('/move',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:f.scope,path:f.path,category:cat.value,name:nm.value})});$('modal').classList.add('hidden');await refresh()}catch(e){alert(e.message)}};let del=document.createElement('button');del.className='danger';del.textContent='删除';del.style.margin='10px';del.onclick=async()=>{if(!confirm('确定删除该文件？'))return;try{await api('/files?scope='+f.scope+'&path='+encodeURIComponent(f.path),{method:'DELETE'});$('modal').classList.add('hidden');await refresh()}catch(e){alert(e.message)}};$('modalBody').append(cat,nm,save,del);$('modal').classList.remove('hidden')}
async function upload(){let selected=[...$('files').files];if(!selected.length)return;let ok=0,errors=[];for(const file of selected){$('progress').textContent='正在上传 '+(ok+errors.length+1)+' / '+selected.length+'：'+file.name;let form=new FormData();form.append('file',file,file.name);form.append('scope',$('scope').value);form.append('category',$('category').value);try{await api('/upload',{method:'POST',body:form});ok++}catch(e){errors.push(file.name+'：'+e.message)}}$('files').value='';$('progress').textContent='完成：成功 '+ok+' 个，失败 '+errors.length+' 个';if(errors.length)show($('uploadMsg'),errors.join('；'),true);else show($('uploadMsg'),'全部上传成功');await refresh()}
$('loginBtn').onclick=login;$('password').onkeydown=e=>{if(e.key==='Enter')login()};$('uploadBtn').onclick=upload;$('refresh').onclick=refresh;$('search').oninput=render;$('filter').onchange=render;$('close').onclick=()=>$('modal').classList.add('hidden');$('logout').onclick=async()=>{await api('/logout',{method:'POST'});location.reload()};$('export').onclick=()=>{let b=new Blob([JSON.stringify(files,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='asset-index.json';a.click();URL.revokeObjectURL(a.href)};boot();
</script></body></html>`;
export default {async fetch(req,env){try{return await handle(req,env)}catch(e){return json({error:e.message||"服务器内部错误"},500)}}};
