import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, stat, realpath, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveRoomLink, restoreRoomLink, tidyLinks } from './links.js';
import { fixture, clientApi } from './test-support/archive-fixture.mjs';

test('native archive keeps workspace membership; single unarchive restores same identity over three rounds',async()=>{
 const f=await fixture();try{
  const a=await f.add(1);await writeFile(join(a.directory,'keep.txt'),'durable');await f.request();
  const workspace=f.workspaces[0];const log=JSON.stringify(f.events.get(a.id));
  for(let i=0;i<3;i++){
   await f.registry.archiveSession(a.id);await f.request();
   assert.ok(f.workspaces.includes(workspace),'archived row must remain in native workspace projection');
   assert.ok(workspace.sessionIds.includes(a.id));assert.ok(f.archived.has(a.id));
   await f.registry.unarchiveSession(a.id);await f.request();
   assert.equal(f.workspaces[0].id,workspace.id);assert.equal(await readFile(join(a.directory,'keep.txt'),'utf8'),'durable');
   assert.equal(JSON.stringify(f.events.get(a.id)),log);
  }
 }finally{await f.close();}
});

test('legacy archived sessions regain membership without clearing archive flags',async()=>{
 const f=await fixture();try{const a=await f.add(2,{register:false});f.archived.add(a.id);await f.request();
 assert.ok(f.workspaces.some(w=>w.sessionIds.includes(a.id)));assert.ok(f.archived.has(a.id));
 }finally{await f.close();}
});

test('archive links resolve across moves and legacy relative targets are repaired',async()=>{
 const f=await fixture();try{const a=await f.add(3);await f.request();
 const moved=await archiveRoomLink({root:f.root,target:a.target,slug:'Room-3'});
 assert.equal(await realpath(join(f.root,'.archive',moved.to)),a.directory);
 await restoreRoomLink({root:f.root,target:a.target});assert.equal(await realpath(join(f.root,moved.to)),a.directory);
 await rm(join(f.root,moved.to));await symlink(a.target,join(f.root,'.archive',moved.to));
 await archiveRoomLink({root:f.root,target:a.target,slug:'Room-3'});
 assert.equal(await realpath(join(f.root,'.archive',moved.to)),a.directory);
 }finally{await f.close();}
});

test('boot keeps archived rooms on disk and retains native archived membership across restarts',async()=>{
 const f=await fixture();try{const a=await f.add(4);await f.request();f.archived.add(a.id);await f.restart();
 // 取消自动 GC：boot 不再删目录，归档只影响入口位置。
 assert.equal((await stat(a.directory)).isDirectory(),true);
 assert.ok(f.workspaces.some(w=>w.sessionIds.includes(a.id)));
 for(let i=0;i<2;i++) await f.request();
 assert.equal((await stat(a.directory)).isDirectory(),true);
 await f.registry.unarchiveSession(a.id);await f.request();
 assert.equal(await realpath(join(f.root,'Room-4')),a.directory);
 }finally{await f.close();}
});

test('shared-room archive preserves live sibling; all-archived content and links survive reboot',async()=>{
 const f=await fixture();try{const a=await f.add(5);const b=await f.add(6,{cwd:a.directory});await writeFile(join(a.directory,'keep'),'x');await f.request();
 f.archived.add(a.id);await f.request();assert.equal(await realpath(join(f.root,'Room-5')),a.directory);
 f.archived.add(b.id);await f.restart();assert.ok(f.workspaces[0].sessionIds.includes(a.id));assert.ok(f.workspaces[0].sessionIds.includes(b.id));
 assert.equal(await realpath(join(f.root,'.archive','Room-5')),a.directory);
 await f.registry.unarchiveSession(b.id);await f.request();assert.equal(await realpath(join(f.root,'Room-5')),a.directory);assert.ok(f.archived.has(a.id));
 }finally{await f.close();}
});

test('reclaimed title survives a collision and restoration never overwrites another room',async()=>{
 const f=await fixture();try{const a=await f.add(9);await writeFile(join(f.root,'Room-9'),'foreign-name');await f.request();
 assert.equal(await realpath(join(f.root,'Room-9-2')),a.directory);
 f.archived.add(a.id);await f.restart();await f.request();
 await writeFile(join(f.root,'Room-9-2'),'another-owner');
 await f.registry.unarchiveSession(a.id);await f.request();
 assert.equal(await readFile(join(f.root,'Room-9-2'),'utf8'),'another-owner');
 assert.equal(await realpath(join(f.root,'Room-9-2-2')),a.directory);
 }finally{await f.close();}
});

test('archiving no longer reclaims the room: directory, aliases and unrelated files stay',async()=>{
 const f=await fixture();try{const a=await f.add(10);await f.request();await mkdir(join(f.root,'.archive'),{recursive:true});
 await symlink(a.target,join(f.root,'.archive','legacy'));
 await symlink(`../${a.target}`,join(f.root,'.archive','duplicate'));
 await writeFile(join(f.root,'.archive','keep.txt'),'keep');
 f.archived.add(a.id);await f.restart();await f.request();
 // 取消自动目录 GC 后的语义：归档只挪标题入口，房间目录必须原地保留。
 assert.equal((await stat(a.directory)).isDirectory(),true);
 assert.equal(await readFile(join(f.root,'.archive','keep.txt'),'utf8'),'keep');
 // 房间入口要么已挪进 `.archive/`，要么因为归档目录里已有手制链接而留在原位：
 // 两种都算「有个能点回去的名字」，重要的是目录和文件没被动过。
 const names=[...(await readdir(join(f.root,'.archive'))).filter(n=>n!=='keep.txt'),...(await readdir(f.root)).filter(n=>n.startsWith('Room-'))];
 const resolved=await Promise.all(names.map(n=>realpath(join(f.root,'.archive',n)).catch(()=>realpath(join(f.root,n)).catch(()=>null))));
 assert.ok(resolved.includes(a.directory), '至少一个入口仍指向原房间');
 }finally{await f.close();}
});

test('archive link tidy writes root-relative room keys and preserves resolving targets',async()=>{
 const f=await fixture();try{const a=await f.add(11);await f.request();f.archived.add(a.id);await f.request();
 await symlink(`../${a.target}`,join(f.root,'.archive','extra'));
 await tidyLinks({root:f.root,apply:true});
 const metadata=JSON.parse(await readFile(join(f.root,'.links.json'),'utf8'));
 assert.equal(Object.keys(metadata.rooms).some(k=>k.startsWith('../')),false);
 assert.equal(await realpath(join(f.root,'.archive',metadata.rooms[a.target])),a.directory);
 }finally{await f.close();}
});

test('maintenance restore reconciles managed membership and directories before responding',async()=>{
 const f=await fixture();try{const a=await f.add(7,{register:false});const foreign=await f.add(8,{cwd:join(f.root,'foreign'),register:false});
 f.archived.add(a.id);f.archived.add(foreign.id);await rm(a.directory,{recursive:true});
 const result=await f.request('/unarchive');assert.deepEqual(result.restored,[a.id]);
 assert.ok(f.workspaces.some(w=>w.sessionIds.includes(a.id)));assert.equal((await stat(a.directory)).isDirectory(),true);assert.ok(f.archived.has(foreign.id));
 }finally{await f.close();}
});

test('B2-F001: sidebar adapter preserves native menu children and disposes its subscriptions', async () => {
  const api = await clientApi(id => id === 'react' ? { useMemo: fn => fn() } : { jsx: (component, props) => ({ component, props }) });
  const id = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ordinary = 'ordinary';
  const cwd = `/fixture/.sessions/${id}`;
  const list = { ids: [id, ordinary], byId: { [id]: { id, cwd, blank: true }, [ordinary]: { id: ordinary, cwd: '/regular', blank: false } } };
  let workspace = { archivedSessionIds: [id, ordinary], items: [{ path: cwd, sessionIds: [id] }, { path: '/regular', sessionIds: [ordinary] }] };
  const entry = { component: function WorkspaceBrowser() {}, options: { priority: 0 }, children: { menu: { kind: 'list', scope: 'root' } }, store: {}, inject: () => ({}), locale: 'workspace' };
  let registration, wrapped, onWorkspace, onSlots, disposed = 0;
  const child = { options: { id: 'unarchive', priority: 0, order: 10 }, component: function NativeRestore() {}, inject: () => ({}) };
  const mirrored = [];
  const opened = [];
  const cleanup = api.installArchivedBlankBrowser({ effect: fn => fn(), slots: {
    entries: key => key === 'sidebar.workspaces' ? [entry] : [child],
    subscribe: (key, fn) => { if (key === 'sidebar.workspaces') onSlots = fn; return () => disposed++; },
    register: (options, component) => { if (options.name === 'sidebar.workspaces') { registration = options; wrapped = component; } else mirrored.push({ options, component }); return () => disposed++; },
  } }, { sessions: { list: { getSnapshot: () => list } }, workspaces: { list: {
    getSnapshot: () => workspace, subscribe: fn => { onWorkspace = fn; return () => disposed++; },
  } }, uiWorkspace: { openSession: value => opened.push(value) } });
  assert.equal(registration.children['chat-sessions.menu'], entry.children.menu);
  assert.equal(registration.children.menu, undefined, 'never redeclare native child ownership');
  assert.equal(mirrored[0].component, child.component); assert.equal(mirrored[0].options.inject, child.inject);
  assert.equal(mirrored[0].options.name, 'chat-sessions.menu');
  assert.equal(mirrored[0].options.id, 'unarchive'); assert.equal(mirrored[0].options.order, 10);
  assert.equal(registration.store, entry.store); assert.equal(registration.inject, entry.inject); assert.equal(registration.locale, entry.locale);
  assert.equal(registration.priority, -100);
  const calls = [];
  const nativeProps = { useWorkspaces: fn => fn(workspace), useSessions: fn => fn(list), renderSlot: (...args) => calls.push(args) };
  const render = wrapped(nativeProps); assert.equal(render.component, entry.component);
  const owner = {}, hookContext = { open: true };
  render.props.renderSlot('menu', owner, { hookContext });
  assert.deepEqual(calls, [['chat-sessions.menu', owner, { hookContext }]], 'delegate contextual menu Hooks intact');
  const projected = render.props.useSessions(value => value);
  assert.equal(projected.byId[id].blank, false); assert.equal(list.byId[id].blank, true); assert.equal(projected.byId[ordinary], list.byId[ordinary]);
  onSlots(); // Own registration notification must not remount or re-register.
  workspace = { ...workspace, archivedSessionIds: [] }; onWorkspace(); onWorkspace();
  assert.deepEqual(opened, [id], 'only restored managed blank is selected, once');
  assert.equal(api.projectArchivedBlanks(list, workspace), list, 'unarchived blank projection keeps snapshot identity');
  cleanup(); assert.equal(disposed, 5);
});
