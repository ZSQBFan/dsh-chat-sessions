// Shared, native-independent helpers for the archive tests.
// Both check-archive.mjs (default suite) and check-archive-native.mjs (opt-in suite) import from here.
import { mkdtemp, mkdir, rm, stat, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { apply } from '../index.js';
import { linkTarget } from '../links.js';

export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chat-archive-')));
  const snapshots = [], events = new Map(), workspaces = [], archived = new Set(), cleanups = [];
  let handler, boot;
  const registry = {
    get archivedSessionIds() { return [...archived]; },
    list: () => [...workspaces],
    async create(path, title) {
      await stat(path);
      let w = workspaces.find(w => w.path === path);
      if (!w) {
        w = { id: `w-${workspaces.length}-${Math.random()}`, path, title,
          sessionIds: snapshots.filter(s => s.header.cwd === path).map(s => s.header.id),
          async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); },
          async setTitle(t) { this.title = t; } };
        workspaces.push(w);
      }
      return w;
    },
    async delete(id) { const n=workspaces.findIndex(w=>w.id===id); if(n<0)return false;workspaces.splice(n,1);return true; },
    async archiveSession(id) { archived.add(id); },
    async unarchiveSession(id) { archived.delete(id); },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: {
      async list() { return snapshots; },
      async open(id) { return { async read() { return { events: events.get(id) }; }, async close() {} }; },
    },
    sessionController: { async list() { return { items: snapshots.map(s=>({sessionId:s.header.id,blank:!events.get(s.header.id)?.some(e=>e.type==='user/message'),running:false})) }; } },
    sessions: { get() {} }, logger: { warn() {}, info() {} },
    webServer: { register(r) { handler=r.handler; return ()=>{}; } },
    effect(fn,label) { if(label) { boot=fn; return ()=>{}; } const cleanup=fn();cleanups.push(cleanup);return cleanup; },
  };
  apply(ctx, { root });
  async function request(path='/link', body={}) {
    return new Promise((resolve,reject)=> {
      const req={method:'POST',url:`/chat-sessions${path}`,socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
      const res={writeHead(status){this.status=status;},end(text){resolve({status:this.status,...JSON.parse(text)});}};
      Promise.resolve(handler(req,res)).catch(reject);
    });
  }
  async function add(n, { cwd, message=true, register=true }={}) {
    const id=`session-00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const directory=cwd??join(root,'.sessions',id);
    await mkdir(directory,{recursive:true});
    snapshots.push({header:{id,cwd:directory,createdAt:Date.now()},sizeBytes:100+n});
    events.set(id,[{type:'session/title',data:{title:`Room-${n}`},time:Date.now()},...(message?[{type:'user/message',data:{text:'keep'},time:Date.now()}]:[])]);
    if(register) await registry.create(directory,'独立对话');
    return {id,directory,target:linkTarget(directory.split('/').pop())};
  }
  return {root,registry,workspaces,archived,snapshots,events,add,request,
    async restart(){for(const fn of cleanups.splice(0).reverse())fn?.();apply(ctx,{root});const stop=boot();cleanups.push(stop);await request();},
    async close(){for(const fn of cleanups.reverse())fn?.();await rm(root,{recursive:true,force:true});}};
}

export async function clientApi(require = () => ({})) {
  let module;
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { module = value; } } }, Map, Set });
  return module.factory(require);
}

export const rowIds = groups => groups.flatMap(g => g.sessions.map(s => s.id));
