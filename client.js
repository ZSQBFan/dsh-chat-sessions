/**
 * dsh-chat-sessions — client half.
 *
 * Stage map (see README section 7):
 *   S3 (this stage)  conversation.hero.workspace — add one "no workspace" entry
 *                    to the shipped workspace picker, so a blank session can be
 *                    started outside every workspace.
 *   S4               conversation.composer unlock for a workspace-free session.
 *   S5               sidebar top-level row for these sessions (A8 regression).
 *   S6+              host side only (links.js / gc.js / archive.js).
 *
 * Design notes:
 *   - The picker dropdown stays the shipped `Menu`/`Button`/`Modal` primitives;
 *     nothing is drawn from scratch.
 *   - `conversation.hero.workspace` is a `single` slot: a second registration at
 *     the same priority throws ("register at a different priority to shadow it
 *     (lowest renders)"), so this half registers at priority -100 and takes over
 *     the dropdown while leaving the shipped entry (and its child slot
 *     declaration) in place.
 *   - If the primitives cannot be resolved this half registers nothing and the
 *     shipped picker keeps rendering — the safe degradation path. There is no
 *     hand-drawn fallback menu on purpose.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-sessions',
  factory(require) {
    'use strict';

    const React = require('react');
    const { Fragment, jsx, jsxs } = require('react/jsx-runtime');

    /** Slot + locale identity. */
    const HERO_PICKER_SLOT = 'conversation.hero.workspace';
    const NS = 'chat-sessions';

    /** Picklist ids: the first is ours, the second mirrors the shipped entry. */
    const NO_WORKSPACE_ID = '::dsh-chat-sessions';
    const ADD_WORKSPACE_ID = '::add-workspace';

    /** `workspaceDisplayTitle` semantics from @deepseek-ai/dsh-api-workspace-controller. */
    const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace';

    /** Seed-module specifiers this half reads at runtime. */
    const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';

    const dictionaries = {
      zh: {
        'picker.noWorkspace': '独立对话',
        'picker.addWorkspace': '添加工作区…',
        'picker.defaultWorkspaceName': '默认工作区',
        'error.title': '无法创建独立会话',
        'error.open': '会话已创建，但无法切换到它',
        'error.workspace': '工作区已创建，但没有返回 id',
        'error.dismiss': '知道了',
        close: '关闭',
      },
      en: {
        'picker.noWorkspace': 'Standalone chat',
        'picker.addWorkspace': 'Add workspace…',
        'picker.defaultWorkspaceName': 'Default workspace',
        'error.title': 'Could not create the session',
        'error.open': 'The session was created but could not be opened',
        'error.workspace': 'The workspace was created without an id',
        'error.dismiss': 'OK',
        close: 'Close',
      },
    };

    /**
     * Resolve the shipped primitives once. A miss disables this half instead of
     * throwing inside the slot (which would blank the picker for good).
     */
    function readPrimitives() {
      try {
        const primitives = require(PRIMITIVES);
        if (!primitives || !primitives.Menu) return null;
        return primitives;
      } catch {
        return null;
      }
    }

    /** Same normalization the shipped picker applies to a stored workspace title. */
    function displayTitle(title, localizedDefault) {
      return title === DEFAULT_WORKSPACE_DIRECTORY ? localizedDefault : title;
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return typeof error === 'string' ? error : String(error);
    }

    /**
     * Build the dropdown component. Services are captured in the closure so the
     * component itself only depends on the slot props.
     */
    function createHeroWorkspaceMenu(primitives, services) {
      const { Button, Menu, Modal } = primitives;
      /** Icons are cosmetic: a missing export must not take the dropdown down. */
      const icon = (candidate) => (typeof candidate === 'function' ? candidate : () => null);
      const IconFolder = icon(primitives.IconFolderCloseRegular);
      const IconPlus = icon(primitives.IconPlusOutlineRegular);
      const IconNewChat = icon(primitives.IconNewChatOutlineRegular);
      /** Neither hook nor translator is guaranteed if the shell changes under us. */
      const useNoWorkspaces = () => undefined;
      const identity = (key) => key;

      return function HeroWorkspaceMenu(props) {
        const { anchorRef, onClose, onPick, open, selectedId } = props;
        const t = typeof props.t === 'function' ? props.t : identity;
        const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useNoWorkspaces;
        const snapshot = useWorkspaces((state) => state);
        const [pending, setPending] = React.useState(false);
        const [failure, setFailure] = React.useState(null);

        // Receipt workspaces (one per standalone session, path under `<root>/.sessions/`) are an
        // implementation detail of the composer unlock: never offer them as a place to work.
        const workspaces = (Array.isArray(snapshot?.items) ? snapshot.items : []).filter(
          (workspace) => !isReceiptWorkspace(workspace),
        );

        const addEntry = {
          id: ADD_WORKSPACE_ID,
          label: t('picker.addWorkspace'),
          icon: jsx(IconPlus, { size: 16 }),
          disabled: pending,
        };
        const standaloneEntry = {
          id: NO_WORKSPACE_ID,
          label: t('picker.noWorkspace'),
          icon: jsx('span', {
            [CHIP_BADGE_ATTRIBUTE]: 'row',
            style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
            dangerouslySetInnerHTML: { __html: BADGE_SVG },
          }),
          disabled: pending,
        };

        // The shipped `WorkspaceSnapshot.items` entries carry `workspaceId` (the session-facing
        // summary, not the registry entity); `id` is only a fallback for other shapes.
        const rows = workspaces.map((workspace) => ({
          id: workspace.workspaceId ?? workspace.id,
          label: displayTitle(workspace.title, t('picker.defaultWorkspaceName')),
          icon: jsx(IconFolder, { size: 16 }),
          disabled: pending,
        }));
        const items = rows.length > 0 ? [...rows, standaloneEntry] : [addEntry, standaloneEntry];

        const createStandalone = async () => {
          setPending(true);
          try {
            const response = await fetch('/chat-sessions/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{"reuseBlank":true}',
              credentials: 'same-origin',
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload || payload.ok !== true || typeof payload.sessionId !== 'string') {
              const detail = payload && typeof payload.message === 'string' ? payload.message : '';
              throw new Error(detail === '' ? `HTTP ${response.status}` : detail);
            }
            await services.uiWorkspace.openSession(payload.sessionId);
          } catch (error) {
            setFailure(messageOf(error));
          } finally {
            setPending(false);
          }
        };

        const addWorkspace = async () => {
          setPending(true);
          try {
            const path = await services.uiWorkspace.pickDirectory();
            if (typeof path !== 'string' || path === '') return;
            const created = await services.workspaces.create({ path });
            const workspaceId = created?.workspaceId ?? created?.id;
            if (typeof workspaceId !== 'string') throw new Error(t('error.workspace'));
            onPick(workspaceId);
          } catch (error) {
            setFailure(messageOf(error));
          } finally {
            setPending(false);
          }
        };

        const handleSelect = (id) => {
          if (id === ADD_WORKSPACE_ID) {
            onClose();
            void addWorkspace();
            return;
          }
          if (id === NO_WORKSPACE_ID) {
            onClose();
            void createStandalone();
            return;
          }
          onPick(id);
        };

        const getAnchorRect = () => anchorRef?.current?.getBoundingClientRect() ?? null;

        return jsxs(Fragment, {
          children: [
            jsx(Menu, {
              open: open && items.length > 0,
              anchor: null,
              items,
              ...(rows.length > 0 ? { footer: [addEntry] } : {}),
              selectedId,
              onSelect: handleSelect,
              onClose,
              side: 'bottom',
              portal: true,
              getAnchorRect,
            }),
            jsx(Modal, {
              open: failure !== null,
              onClose: () => setFailure(null),
              closeLabel: t('close'),
              title: t('error.title'),
              footer: jsx(Button, {
                variant: 'primary',
                onClick: () => setFailure(null),
                children: t('error.dismiss'),
              }),
              children: jsx('div', {
                role: 'alert',
                style: {
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  color: 'var(--dsw-alias-state-error-primary, #d84a3a)',
                },
                children: failure ?? '',
              }),
            }),
          ],
        });
      };
    }

    /**
     * S5 — flatten the sidebar.
     *
     * A workspace-free session is listed by the shipped sidebar inside a
     * synthetic bucket whose row is `data-row-key="workspace:"` (an empty
     * workspace id) with the title `未分组`. The bucket is the root group, so
     * its `--dsh-workspace-indent` is already `0px`: hiding that one header row
     * leaves its session rows as top-level siblings of the real workspace rows,
     * with no extra indent to fix up.
     *
     * The stylesheet is inserted at materialization time (the loader claims
     * factory-injected <style> tags for HMR cleanup), but every rule is gated on
     * an <html> attribute, so turning the option off leaves the shipped sidebar
     * untouched without shipping a second stylesheet.
     */
    const FLATTEN_ATTRIBUTE = 'data-chat-sessions-flatten';
    /** Flat list ('单列表') has no group sections: standalone sessions are ordinary rows there. */
    const FLAT_ATTRIBUTE = 'data-chat-sessions-flat';
    const STANDALONE_ATTRIBUTE = 'data-chat-sessions-standalone';
    /** Marks a receipt-workspace row (and its group) so the shipped row can be hidden. */
    const OWNED_ROW_ATTRIBUTE = 'data-chat-sessions-owned';
    const OWNED_BUCKET_ATTRIBUTE = 'data-chat-sessions-bucket';
    /** Set on the group section that holds a receipt workspace row. */
    const GROUP_ATTRIBUTE = 'data-chat-sessions-group';
    /**
     * Marks the groups the cluster flattens. Set on top-level cluster groups only: a group that the
     * shipped tree nests under a path ancestor has to keep its box or 「按工作区树」 loses its
     * indentation.
     */
    const FLAT_GROUP_ATTRIBUTE = 'data-chat-sessions-flat';
    /**
     * Marks a group as *not* ours. The stylesheet's default for a container child is "belongs to
     * the cluster" (`order: 100`) and foreign groups opt out with `order: 0`, which is the opposite
     * of the intuitive direction — deliberately: a brand-new receipt group reaches the DOM one
     * frame before our marker pass can tag it, and with the intuitive direction that frame painted
     * it *above* the divider and then snapped it down. Defaulting to the cluster means the very
     * first paint is already in the right place.
     */
    const FOREIGN_ATTRIBUTE = 'data-chat-sessions-foreign';
    /**
     * The synthetic "no workspace" bucket (row `data-row-key="workspace:"`) now carries *real*
     * orphans: delete a workspace that still has sessions and those sessions land here. Its header
     * is only an implementation detail when the bucket is empty (that was the original case — the
     * bucket used to hold nothing but our own standalone sessions). Once it holds orphans the
     * native 「未分组」 label is the only thing telling the user those sessions lost their home,
     * so the header is kept and only the border hack is dropped.
     */
    /**
     * The block that holds the 「未分组」 bucket. It is neither a workspace nor part of the cluster:
     * the shipped tree renders it last, so it keeps that slot with an order above the cluster and,
     * crucially, must not be mistaken for the "last foreign block" the divider rides on.
     */
    const ORPHAN_BUCKET_ATTRIBUTE = 'data-chat-sessions-orphan-bucket';
    /**
     * The orphan bucket sits *after* our cluster (`order: 110`), so the one divider we draw above the
     * cluster is not enough: without a second rule the cluster and 「未分组」 would look like one
     * block. This attribute is only set when both exist and we are in the flat rendering.
     */
    const AFTER_CLUSTER_ATTRIBUTE = 'data-chat-sessions-after-cluster';
    /** Buckets that once held rows; a collapsed bucket keeps its header (see classifyBucket). */
    const bucketHadRows = new WeakSet();
    /** Host-reported count of sessions no workspace claims (see `status().orphans`). */
    let knownOrphans = 0;
    /**
     * Set on the block container that holds the groups. Needed because reordering by CSS `order`
     * requires turning that container into a flex column — and a flex column *shrinks* its children
     * by default when the content is taller than the scroll box, which made the whole workspace
     * strip compress upward for a frame whenever a group was added. The container is marked so the
     * stylesheet can also neutralise `flex-shrink` on its children.
     */
    const CONTAINER_ATTRIBUTE = 'data-chat-sessions-container';
    const DIVIDER_ATTRIBUTE = 'data-chat-sessions-divider';
    const FOREIGN_DIVIDER_ATTRIBUTE = 'data-chat-sessions-after';
    const CLUSTER_DIVIDER_ATTRIBUTE = 'data-chat-sessions-cluster-divider';
    const CLUSTER_HEADER_ATTRIBUTE = 'data-chat-sessions-cluster-header';
    const CLUSTER_HEADER_ACTION_ATTRIBUTE = 'data-chat-sessions-cluster-new';
    const CLUSTER_COLLAPSED_ATTRIBUTE = 'data-chat-sessions-cluster-collapsed';
    const CLUSTER_ERROR_ATTRIBUTE = 'data-chat-sessions-cluster-error';
    const EMPTY_TURN_ATTRIBUTE = 'data-chat-sessions-hide-empty-turn';
    /** Header=1, visible blank=2, pinned rows=3..10, ordinary rows=100. */
    const PIN_ATTRIBUTE = 'data-chat-sessions-rank';
    const PINNED_RANKS = [3, 4, 5, 6, 7, 8, 9, 10];
    /** Pin position -> integer CSS order, applied per chat row. */
    const rankOf = (pinIndex) =>
      typeof pinIndex === 'number' && pinIndex >= 0 && pinIndex < PINNED_RANKS.length
        ? String(pinIndex + 3)
        : '0';
    /** Key-set of the cluster on the previous pass; a different set means "membership changed". */
    let lastBlockKeys = '';
    /** Config kill switch (`glide: false`) — kept so a layout jolt can be bisected without a rebuild. */
    let glideEnabled = true;
    /**
     * `auto` obeys `prefers-reduced-motion`, `force` glides anyway, `off` never glides. `force`
     * exists because a machine-level "reduce motion" setting otherwise makes the reorder animation
     * look broken in a report (`glided` stays 0 by design). See index.js `glideMotion()`.
     */
    let glideMotionMode = 'auto';
    /** `tint` | `prefix` | `off`, from `/chat-sessions/config`. */
    let treeBadge = 'icon';
    /**
     * Reorder glide, matching the shipped `AnimatedRows` (`ROW_GLIDE_MS`, `ease-out`).
     *
     * The shipped list animates its keyed rows when the row *order* changes, but our cluster is
     * reordered by CSS `order` on group sections, which its row diff cannot see — so pinning used
     * to teleport. Motion is armed by the first pointer/key input exactly like the shipped list
     * (a page that has never been touched must not animate on its first paint).
     */
    const GLIDE_MS = 200;
    /**
     * Marks a standalone session that the shipped tree nests inside a real workspace (our room
     * directory sits under `~/.dsh`, and `~/.dsh` is a workspace). Purely a visual cue: the value is
     * `tint` (or `prefix` later), the CSS dims the row's title so it reads as "not a project
     * session" without touching text, layout or behaviour.
     */
    const TREE_BADGE_ATTRIBUTE = 'data-chat-sessions-tree-badge';
    /**
     * The visible marker itself: a 16 px chat glyph prepended to every session row of a nested
     * standalone block. Colour cannot carry this meaning — an archived row is already dimmed by the
     * shipped stylesheet (`--dsw-alias-label-caption`), so "slightly grey" is ambiguous once
     * 「显示已归档」 is on. Shape is the channel that stays unambiguous.
     */
    const BADGE_ELEMENT_ATTRIBUTE = 'data-chat-sessions-badge';
    /** Chip + picker row share the row badge glyph so one thing means "standalone". */
    const CHIP_ATTRIBUTE = 'data-chat-sessions-chip';
    const CHIP_BADGE_ATTRIBUTE = 'data-chat-sessions-chip-badge';
    /** Same silhouette as the picker's chat entry, inlined: no React root, no runtime dependency. */
    const BADGE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.4-.6L3 21l1.7-4.2A8.1 8.1 0 0 1 4 11.5a8.4 8.4 0 0 1 8.5-8.4A8.4 8.4 0 0 1 21 11.5Z"/></svg>';
    const rowMotions = new Map();
    const box_animate = (element, moved) => {
      const key = element.getAttribute('data-row-key');
      const animation = element.animate(
        [{ transform: `translateY(${moved}px)` }, { transform: 'translateY(0px)' }],
        { duration: GLIDE_MS, easing: 'ease-out' },
      );
      rowMotions.set(key, { element, animation });
      animation.onfinish = () => {
        animation.onfinish = null;
        animation.cancel();
        if (rowMotions.get(key)?.animation === animation) rowMotions.delete(key);
      };
    };
    /** Count of blocks that glided in the most recent reorder (sticky diagnostic; see below). */
    const GLIDE_ATTRIBUTE = 'data-chat-sessions-glided';
    const GLIDE_STATE_ATTRIBUTE = 'data-chat-sessions-glide-state';
    let glideArmed = false;
    /**
     * Layout positions of the cluster blocks as they were *last painted*, measured with
     * `offsetTop` so an in-flight animation never pollutes the baseline. This is what lets a
     * membership change animate the rows that get pushed down by a new room: by the time our pass
     * runs, the newcomer is already in the DOM, so a same-pass before/after diff would read zero.
     */
    let lastTops = new Map();
    let lastRowPlacements = new Map();
    // Changes outside this keyed/ranked cluster belong to native AnimatedRows,
    // including its viewport/scroll-clamp compensation and animation start time.
    let lastRowLayout = '';
    /** Native tree membership still belongs to AnimatedRows; flattened rows reconcile below. */
    let lastRowCount = -1;
    const armGlide = () => {
      glideArmed = true;
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', armGlide, { capture: true, once: true, passive: true });
      document.addEventListener('keydown', armGlide, { capture: true, once: true });
    }
    /**
     * Motion journal (diagnostic, sticky, cheap): records every frame in which the first workspace
     * row moved or the block container scrolled. A "the strip shrank upward" report needs to say
     * which of the two moved, so this survives until the next reload and is readable from <html>.
     */
    /**
     * Which client build is actually live. `client.js` is not hot-swapped (only the patch file is),
     * so after every change the app must be quit and reopened — and this tag is how a tester tells
     * "the fix did not work" apart from "the old bundle is still loaded".
     */
    const BUILD_ATTRIBUTE = 'data-chat-sessions-build';
    /** Fallback only: the authoritative build id arrives with `GET /chat-sessions/config`. */
    const BUILD_TAG = 'unknown';
    let buildTag = BUILD_TAG;
    const MOTION_ATTRIBUTE = 'data-chat-sessions-motion';
    const motionLog = [];
    let motionTop = null;
    let motionScroll = null;
    let motionRunning = false;
    const sampleMotion = () => {
      if (typeof document === 'undefined') return;
      const box = document.querySelector('[data-chat-sessions-container]');
      const row = visibleWorkspaceRows()[0];
      const top = row === undefined ? null : Math.round(row.getBoundingClientRect().top);
      const scroll = box === null ? null : Math.round(box.scrollTop);
      if (top !== motionTop || scroll !== motionScroll) {
        motionTop = top;
        motionScroll = scroll;
        motionLog.push(`${Math.round(performance.now())}t${String(top)}s${String(scroll)}`);
        if (motionLog.length > 8) motionLog.shift();
        reportDiagnostics('motion');
        document.documentElement.setAttribute(MOTION_ATTRIBUTE, motionLog.join(' '));
      }
    };
    /**
     * The same burst, but kicked off by a click on a workspace row. "Collapse/expand has no
     * animation right after a reload, and gets it back after opening a session" is a different
     * question from the reorder jolt — this records whether any animation ran at all.
     */
    let burstArmed = false;
    const armRowBurst = () => {
      if (burstArmed || typeof document === 'undefined') return () => {};
      burstArmed = true;
      const onPointerDown = (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-row-key^="workspace:"]') : null;
        if (target !== null) runBurst('expand');
      };
      document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        burstArmed = false;
      };
    };
    /**
     * The shipped `AnimatedRows` deliberately does not animate until the first pointer/key event
     * lands *inside* its `role="tree"` element (`onPointerDownCapture`/`onKeyDownCapture` set
     * `armed = true`), so a freshly opened window collapses/expands a workspace with no motion
     * until the user happens to click a row. A synthetic, selectable-neutral `keydown` aimed at the
     * tree arms it once, without touching selection, menus or the session list.
     */
    let nativeArmed = false;
    const armNativeRows = () => {
      if (nativeArmed || typeof KeyboardEvent !== 'function') return;
      const tree = document.querySelector('[role="tree"]');
      if (tree === null) return;
      nativeArmed = true;
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true, cancelable: true }));
    };
    const startMotionProbe = () => {
      if (motionRunning || typeof requestAnimationFrame !== 'function') return () => {};
      motionRunning = true;
      const stopBurstListener = armRowBurst();
      const armTimer = window.setTimeout(armNativeRows, 600);
      return () => {
        motionRunning = false;
        stopBurstListener();
        window.clearTimeout(armTimer);
        if (burstFrame !== 0) cancelAnimationFrame(burstFrame);
        burstFrame = 0;
        burstLeft = 0;
        burstFrames = [];
      };
    };
    /**
     * Ship the measurements *out* of the page instead of asking a human to read DevTools: the
     * desktop window runs a `dsh-app://` scheme with no debugging port, so a bug that only shows
     * there cannot be inspected from outside. Every mutation of the sidebar posts one compact
     * sample to the host half, which keeps the last few and serves them over
     * `GET /chat-sessions/diagnostics`.
     */
    let lastReportAt = 0;
    const reportDiagnostics = (kind) => {
      const now = typeof performance === 'object' ? performance.now() : 0;
      if (now - lastReportAt < 250) return;
      lastReportAt = now;
      const box = document.querySelector(`[${CONTAINER_ATTRIBUTE}]`);
      const row = visibleWorkspaceRows()[0];
      const sample = {
        build: buildTag,
        kind,
        at: Math.round(now),
        motion: motionLog.join(' '),
        glide: document.documentElement.getAttribute(GLIDE_STATE_ATTRIBUTE) ?? '',
        box: box === null
          ? null
          : {
            clientHeight: Math.round(box.clientHeight),
            scrollHeight: Math.round(box.scrollHeight),
            scrollTop: Math.round(box.scrollTop),
            display: getComputedStyle(box).display,
            children: box.children.length,
          },
        firstRowTop: row === undefined ? null : Math.round(row.getBoundingClientRect().top),
        rows: document.querySelectorAll('[data-row-key]').length,
        // How many owned blocks carry the tree badge right now (0 in "按工作区", >0 in a tree that
        // nests our rooms). Reported so nesting can be confirmed without DevTools.
        badged: document.documentElement.getAttribute('data-chat-sessions-badged') ?? '',
      };
      void fetch('/chat-sessions/diagnostics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sample),
        credentials: 'same-origin',
      }).catch(() => {});
    };
    /**
     * Burst sampler: for ~40 frames after a membership change, record what is actually moving AND
     * which CSS/WAAPI animations are running. A fade-only animation leaves `rect.top` untouched,
     * which is why the earlier frame journal came back clean while the strip still visibly jumped.
     */
    const describeAnimations = () => {
      if (typeof document.getAnimations !== 'function') return '';
      const running = [];
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getTiming?.() ?? {};
        if (timing.duration === 0) continue;
        const target = animation.effect?.target;
        const key = target?.closest?.('[data-row-key]')?.getAttribute('data-row-key') ?? '';
        const name = animation.animationName ?? timing.easing ?? 'anim';
        running.push(`${name.slice(0, 18)}@${key.slice(0, 26)}`);
      }
      return running.slice(0, 6).join(',');
    };
    let burstLeft = 0;
    let burstFrame = 0;
    let burstFrames = [];
    let burstKind = 'membership';
    /** Start a 40-frame burst and tag it, so one profile answers several different questions. */
    const runBurst = (kind) => {
      burstKind = kind;
      startBurst();
    };
    const sampleBurst = () => {
      burstFrame = 0;
      sampleMotion();
      const box = document.querySelector(`[${CONTAINER_ATTRIBUTE}]`);
      const rows = visibleWorkspaceRows();
      const tops = [];
      for (let index = 0; index < Math.min(rows.length, 4); index += 1) {
        tops.push(Math.round(rows[index].getBoundingClientRect().top));
      }
      const tree = document.querySelector('[role="tree"]');
      const treeTop = tree === null ? '' : Math.round(tree.getBoundingClientRect().top);
      const outerTop = box?.parentElement === null || box?.parentElement === undefined
        ? ''
        : Math.round(box.parentElement.getBoundingClientRect().top);
      const marks = box === null
        ? ''
        : Array.from(box.children).map((child) => {
          const mark = child.hasAttribute(GROUP_ATTRIBUTE) ? 'G' : child.hasAttribute(FOREIGN_ATTRIBUTE) ? 'F' : '?';
          return `${mark}${getComputedStyle(child).order}`;
        }).join(' ');
      burstFrames.push(`${Math.round(performance.now())}|${tops.join(',')}|${box === null ? '' : Math.round(box.scrollTop)}|${treeTop}|${outerTop}|${marks}|${describeAnimations()}`);
      burstLeft -= 1;
      if (burstLeft > 0) {
        burstFrame = requestAnimationFrame(sampleBurst);
        return;
      }
      void fetch('/chat-sessions/diagnostics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ build: buildTag, kind: `burst:${burstKind}`, frames: burstFrames }),
        credentials: 'same-origin',
      }).catch(() => {});
      burstFrames = [];
    };
    const startBurst = () => {
      if (typeof requestAnimationFrame !== 'function') return;
      if (burstLeft > 0) return;
      burstLeft = 40;
      burstFrame = requestAnimationFrame(sampleBurst);
    };
    /**
     * Receipt rows come first in the DOM (new workspaces are prepended) and are hidden by our own
     * stylesheet — `getBoundingClientRect()` on one of those is a permanent `0`, which silently
     * made the first version of the motion journal look frozen. Always measure a *visible* row.
     */
    const visibleWorkspaceRows = () => {
      const rows = [];
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
        if (row.hasAttribute(OWNED_ROW_ATTRIBUTE)) continue;
        if (row.offsetParent === null) continue;
        rows.push(row);
      }
      return rows;
    };
    const OWNER_ID = 'dsh-chat-sessions';
    const STYLE_ID = `${OWNER_ID}/ungrouped.css`;

    function ungroupedCss() {
      const gate = `html[${FLATTEN_ATTRIBUTE}]`;
      return [
        `/* dsh-chat-sessions: hide the synthetic "no workspace" bucket header. */`,
        `/* receipt workspace: the row is an implementation detail, the session is the row. */`,
        `${gate} [${OWNED_ROW_ATTRIBUTE}]{display:none!important}`,
        `${gate} [${GROUP_ATTRIBUTE}]{--dsh-workspace-indent:0px!important;margin-top:0!important;padding-top:0!important;border-top:0!important}`,
        // The shipped list orders groups by registry recency (a new workspace is prepended), which
        // would put the standalone cluster *above* every project. Reorder the block container and
        // push the cluster to the end: same nodes, same rows, only the paint order changes.
        `${gate} [${CONTAINER_ATTRIBUTE}]{display:flex!important;flex-direction:column!important}`,
        // `flex-shrink` defaults to 1: without this the column squeezes every row when a group is
        // added (content taller than the scroll box), which reads as "the strip collapsed upward".
        `${gate} [${CONTAINER_ATTRIBUTE}] > *{flex:0 0 auto!important}`,
        // Scroll anchoring stays at the browser default on purpose: an earlier version disabled it
        // to fight "the strip jumps up when a room is added", but the `order` polarity below is
        // what actually fixed that. Disabling the anchor only removed the browser's own
        // compensation when a row is inserted inside a group — which is what made that case look
        // like it dropped in from the divider.
        // A pinned standalone room must surface at the head of the cluster, and several of them in
        // order of latest activity. `order` only takes integers, so the ranks are materialised here
        // and the marker pass stamps `data-chat-sessions-rank` (1..8 piped, 0 unpinned).
        // Group-only on purpose: the same rank attribute is mirrored onto rows for verification,
        // and `order` there would be a silent no-op with a confusing name.
        // Default = cluster; foreign groups opt out. See FOREIGN_ATTRIBUTE for why the polarity
        // is inverted (a new receipt group must be in the cluster on its very first paint).
        // Safety net for the very first paint of a new group: the marked container is stamped by
        // our own pass, but the shipped tree element is always there. Both selectors say the same
        // thing ("children default to the cluster"), so a re-created container cannot expose a
        // frame where the newcomer sorts with the workspaces.
        `${gate} [${CONTAINER_ATTRIBUTE}] > *{order:100}`,
        `${gate} [role="tree"] > *{order:100}`,
        `${gate} [${FOREIGN_ATTRIBUTE}]{order:-1}`,
        // Orphan bucket (「未分组」) keeps the shipped last slot, below the cluster.
        `${gate} [${ORPHAN_BUCKET_ATTRIBUTE}]{order:110!important}`,
        `${gate} [${AFTER_CLUSTER_ATTRIBUTE}]{margin-top:4px!important;padding-top:4px!important;border-top:1px solid var(--dsw-alias-border-l1)!important}`,
        // Tree mode only: a nested standalone row reads as secondary text. `opacity` is used instead
        // of `color` because the shipped title sets its own colour on a child span, and this must
        // not change the row height or the FLIP baseline.
        `${gate} [${TREE_BADGE_ATTRIBUTE}="tint"] [data-row-key^="session:"]{opacity:.65!important}`,
        `${gate} [${TREE_BADGE_ATTRIBUTE}="tint"] [data-row-key^="session:"]:hover{opacity:1!important}`,
        // The glyph must not move the title baseline or take focus: fixed 16 px slot, neutral ink.
        `[${CHIP_ATTRIBUTE}="standalone"] button[aria-label="选择工作区"]>svg:first-of-type{display:none!important}`,
        `[${CHIP_ATTRIBUTE}="standalone"] button[aria-label="选择工作区"]>span[${CHIP_BADGE_ATTRIBUTE}]{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-right:0}`,
        `${gate} [${BADGE_ELEMENT_ATTRIBUTE}]{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-right:2px;color:var(--dsw-alias-label-tertiary);pointer-events:none}`,
        ...PINNED_RANKS.map((rank) => `${gate} [${GROUP_ATTRIBUTE}][${PIN_ATTRIBUTE}="${rank}"]{order:${rank}}`),
        // A room can hold more than one chat (a fork inherits its parent's directory) and the
        // shipped list renders those chats as sibling rows *inside* the group box. Ranking the box
        // therefore ranked all of its chats, so a freshly pinned chat dragged its unpinned sibling
        // along and that sibling landed above an older pin from another room — report: "较新的会话
        // 会把旧的顶掉". `display:contents` removes the wrapper box (the row itself is already
        // hidden), which promotes the chat rows into the list's own flex context: they become
        // siblings of the group boxes, so a row-level `order` finally means "rise past the other
        // rooms", not "rise inside my room". Everything that decorated the wrapper (indent,
        // separators) is drawn on the row or on the foreign divider instead, so nothing is lost.
        `${gate} [${FLAT_GROUP_ATTRIBUTE}]{display:contents!important}`,
        `${gate} [${FLAT_GROUP_ATTRIBUTE}]>div:not([data-row-key]){display:contents!important}`,
        // Native groupSection > * + * supplies 2px on the HoverCard wrapper. A contents
        // wrapper has no margin box, so restore that spacing on the promoted session row.
        `${gate} [${FLAT_GROUP_ATTRIBUTE}] [data-row-key^="session:"]{margin-top:2px!important}`,
        `${gate} [${GROUP_ATTRIBUTE}] [data-row-key^="session:"]{flex:0 0 auto!important;order:100}`,
        ...PINNED_RANKS.map(
          (rank) =>
            `${gate} [${GROUP_ATTRIBUTE}] [data-row-key^="session:"][${PIN_ATTRIBUTE}="${rank}"]{order:${rank}}`,
        ),
        `${gate} [${DIVIDER_ATTRIBUTE}]{margin-top:6px!important;padding-top:5px!important;border-top:1px solid var(--dsw-alias-border-l1)!important}`,
        `${gate} [${CLUSTER_DIVIDER_ATTRIBUTE}]{position:relative!important}`,
        // Keep the original 12px spacer, but paint the line on the animated header.
        `${gate} [${CLUSTER_DIVIDER_ATTRIBUTE}]::before{content:"";display:block;order:0;flex:0 0 auto;height:0;margin:6px 0 5px;padding:0;border-top:1px solid transparent}`,
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}]{position:relative;order:1!important;flex:0 0 auto!important;align-self:stretch;width:100%;min-width:0;box-sizing:border-box}`,
        `${gate} [${CLUSTER_DIVIDER_ATTRIBUTE}]>[${CLUSTER_HEADER_ATTRIBUTE}]::before{content:"";position:absolute;left:0;right:0;top:-6px;border-top:1px solid var(--dsw-alias-border-l1);pointer-events:none}`,
        // Native rowKeys does not include our extra keyed header. Its removed-row
        // snapshot can clone it into the exit overlay: never paint that inert copy.
        // The normal marker cleanup removes it; native onfinish releases its exit.
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}][data-chat-sessions-mode-decoration]::before{opacity:0}`,
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}][inert]{display:none!important}`,
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}]>:last-child{margin-left:auto;flex:0 0 auto;opacity:1;pointer-events:auto}`,
        // Native action shells stay display:none without pointer hover; expose ours to keyboard focus too.
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}]:focus-within>:last-child{display:flex}`,
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}]>:first-child svg{width:16px;height:16px}`,
        `${gate} [${CLUSTER_HEADER_ACTION_ATTRIBUTE}]{opacity:0;pointer-events:none}`,
        `${gate} [${CLUSTER_HEADER_ATTRIBUTE}]:hover [${CLUSTER_HEADER_ACTION_ATTRIBUTE}],${gate} [${CLUSTER_HEADER_ATTRIBUTE}]:focus-within [${CLUSTER_HEADER_ACTION_ATTRIBUTE}]{opacity:1;pointer-events:auto}`,
        `${gate} [${CLUSTER_HEADER_ACTION_ATTRIBUTE}]:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}`,
        `${gate} [${CONTAINER_ATTRIBUTE}][${CLUSTER_COLLAPSED_ATTRIBUTE}] [${GROUP_ATTRIBUTE}],${gate} [${CONTAINER_ATTRIBUTE}][${CLUSTER_COLLAPSED_ATTRIBUTE}] [${GROUP_ATTRIBUTE}] [data-row-key^="session:"]{display:none!important}`,
        `${gate} [${CLUSTER_ERROR_ATTRIBUTE}]{order:1;flex:0 0 auto;padding:4px 8px;white-space:normal;overflow-wrap:anywhere;font-size:12px;color:var(--dsw-alias-label-secondary)}`,
      ].join('\n');
    }

    /**
     * Hide the settled-turn badge of a turn that carries no content.
     *
     * A standalone session has to open its first turn so the shipped composer
     * stops treating the session as blank (see README section 11); that turn is
     * empty by construction and would otherwise leave a permanent
     * "已完成，用时 1 秒" row above the conversation. The shipped node exposes
     * `data-turn-process-messages/tool-calls/subagents`, so the rule can target
     * exactly an empty turn and leaves every real turn badge alone.
     */
    function emptyTurnCss() {
      return [
        `/* dsh-chat-sessions: no badge above an empty turn. */`,
        `html[${EMPTY_TURN_ATTRIBUTE}] button[data-turn-process][data-turn-process-messages="0"][data-turn-process-tool-calls="0"][data-turn-process-subagents="0"]{display:none!important}`,
      ].join('\n');
    }

    /** Root that owns the session directories; filled from `/chat-sessions/config`. */
    let chatRoot = '';

    /**
     * Whether a workspace is a receipt for a standalone session directory.
     *
     * Path-only on purpose: the chat root arrives from an async config call, and until it does a
     * root-based test lets every receipt through — which is how one showed up in the picker. The
     * directory layout (`.sessions/session-<uuid>`) is unambiguous without knowing the root.
     * @param workspace workspace summary from the shipped workspaces snapshot.
     * @returns true for `<...>/.sessions/session-<uuid>` registrations.
     */
    function isReceiptWorkspace(workspace) {
      const path = workspace?.path;
      if (typeof path !== 'string') return false;
      return /\.sessions\/session-[0-9a-fA-F-]{8,}$/u.test(path);
    }

    /** Sidebar-only compatibility for native blank-before-archive visibility (B2-F001). */
    function projectArchivedBlanks(list, workspace) {
      const archived = new Set(workspace.archivedSessionIds);
      let byId;
      for (const room of workspace.items) {
        if (!isReceiptWorkspace(room)) continue;
        if (chatRoot && !room.path.startsWith(`${chatRoot}/.sessions/`)) continue;
        for (const id of room.sessionIds) {
          const summary = list.byId[id];
          if (!archived.has(id) || summary?.blank !== true || summary.origin === 'subagent'
            || summary.cwd !== room.path) continue;
          byId ??= { ...list.byId };
          byId[id] = { ...summary, blank: false };
        }
      }
      return byId ? { ...list, byId } : list;
    }

    /** Keep native browser/store/menu code; project only the browser's useSessions input. */
    function installArchivedBlankBrowser(ctx, services) {
      const slot = 'sidebar.workspaces';
      return ctx.effect(() => {
        let stopEntry;
        let native;
        const reconcile = () => {
          const entry = ctx.slots.entries(slot).find(item => item.component?.name === 'WorkspaceBrowser');
          if (entry === native) return;
          stopEntry?.(); stopEntry = undefined; native = entry;
          if (!entry) return;
          const aliases = new Map(Object.keys(entry.children ?? {}).map(key => [key, `chat-sessions.${key}`]));
          function ArchivedBlankBrowser(props) {
            const workspace = props.useWorkspaces(state => state);
            const useSessions = React.useMemo(() => selector => props.useSessions(state =>
              selector(projectArchivedBlanks(state, workspace))), [props.useSessions, workspace]);
            const renderSlot = React.useMemo(() => (key, ...args) => props.renderSlot(aliases.get(key), ...args), [props.renderSlot]);
            return jsx(entry.component, { ...props, useSessions, renderSlot });
          }
          // Child declarations have one owner. Private aliases delegate to the
          // original native entries without replacing their menu/action code.
          const stopBrowser = ctx.slots.register({
            name: slot, priority: (entry.options.priority ?? 0) - 100,
            store: entry.store, inject: entry.inject, locale: entry.locale,
            children: Object.fromEntries([...aliases].map(([key, alias]) => [alias, entry.children[key]])),
          }, ArchivedBlankBrowser);
          const stopChildren = [...aliases].map(([key, alias]) => {
            const live = new Map();
            const sync = () => {
              const entries = ctx.slots.entries(key);
              for (const [child, dispose] of live) if (!entries.includes(child)) { dispose(); live.delete(child); }
              for (const child of entries) if (!live.has(child)) live.set(child, ctx.slots.register({
                ...child.options, name: alias,
                store: child.store, inject: child.inject, locale: child.locale,
              }, child.component));
            };
            const stop = ctx.slots.subscribe(key, sync); sync();
            return () => { stop(); for (const dispose of live.values()) dispose(); };
          });
          stopEntry = () => { for (const stop of stopChildren) stop(); stopBrowser(); };
        };
        const stopWatching = ctx.slots.subscribe(slot, reconcile);
        reconcile();
        // Native single restore clears the archive flag. Select the same blank
        // through public navigation so its ordinary current-only row is visible.
        let previous = new Set(services.workspaces.list.getSnapshot().archivedSessionIds);
        const stopRestoring = services.workspaces.list.subscribe(() => {
          const workspace = services.workspaces.list.getSnapshot();
          const next = new Set(workspace.archivedSessionIds);
          const list = services.sessions.list.getSnapshot();
          const before = projectArchivedBlanks(list, { ...workspace, archivedSessionIds: [...previous] });
          previous = next;
          for (const id of before.ids) {
            if (!next.has(id) && before.byId[id] !== list.byId[id]) services.uiWorkspace.openSession(id);
          }
        });
        return () => { stopWatching(); stopRestoring(); stopEntry?.(); };
      }, 'chat-sessions: archived blank sidebar projection');
    }

    /**
     * Tell apart an empty 「未分组」 bucket from one that carries real orphans.
     *
     * Ours (receipt rooms) live in their own groups, so the bucket only holds sessions whose
     * workspace was deleted. An empty bucket gets its header hidden; a populated one keeps the
     * shipped 「未分组」 label — that label is the only thing telling the user those sessions lost
     * their home. Runs on every marker pass.
     */
    function classifyBucket() {
      if (typeof document === 'undefined' || !document.body) return 0;
      let orphans = 0;
      for (const header of document.querySelectorAll('[data-row-key="workspace:"]')) {
        const bucket = header.parentElement;
        if (bucket === null) continue;
        const count = bucket.querySelectorAll('[data-row-key^="session:"]').length;
        orphans += count;
        // A collapsed group renders no session rows, so "0 rows" must not be read as "empty":
        // hiding the header of a collapsed-but-populated bucket would remove the only affordance
        // that could ever expand it again. Once seen populated, stay populated.
        if (count > 0) bucketHadRows.add(bucket);
        // The shipped tree only renders this header when it has rows, so it must never be hidden:
        // hiding it would strand the orphans with no label and no way back. Count rows only for the
        // cluster-divider bookkeeping.
        bucket.toggleAttribute(ORPHAN_BUCKET_ATTRIBUTE, count > 0 || bucketHadRows.has(bucket) || knownOrphans > 0);
      }
      return orphans;
    }

    /** Insert the package stylesheet once; the loader tags and reclaims it. */
    function insertStyleSheet(css) {
      if (typeof document === 'undefined' || !document.head) return () => {};
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing) return () => existing.remove();
      const style = document.createElement('style');
      style.setAttribute('data-plugin', OWNER_ID);
      style.setAttribute('data-plugin-css', STYLE_ID);
      style.textContent = css;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /** Visual-only bridge across the native grouping reset. Never moves a real row. */
    function createModeTransition() {
      let layout = null;
      let snapshot = null;
      let overlay = null;
      let exitingHeader = null;
      const animations = new Set();
      const peerMotions = new Map();
      const exits = new Map();
      const decorations = new Set();
      const measure = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).display === 'none') return null;
        const style = getComputedStyle(element);
        return { element, rect, opacity: Number(style.opacity || 1), clipPath: style.clipPath || 'none',
          font: style.font, color: style.color };
      };
      const clear = () => {
        for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
        animations.clear(); peerMotions.clear(); exits.clear();
        for (const node of decorations) node.removeAttribute('data-chat-sessions-mode-decoration');
        decorations.clear(); overlay?.remove(); overlay = null; exitingHeader = null;
      };
      const capture = (kind = 'mode') => {
        if (!layout) return;
        const peers = new Map();
        for (const element of layout.peers?.() ?? []) {
          const row = measure(element);
          if (row) peers.set(element.getAttribute('data-row-key'), row);
        }
        const rows = new Map();
        for (const element of layout.rows) {
          const key = element.getAttribute('data-row-key');
          const foldExit = clusterMotions.get(element.closest(`[${CONTAINER_ATTRIBUTE}]`))?.exits.get(element);
          const visual = exits.get(key) ?? foldExit ?? element;
          const row = measure(visual);
          if (row) rows.set(key, { ...row, anchor: layout.anchor(element) });
        }
        snapshot = { kind, capturedAt: Date.now(), nested: layout.nested, collapsed: layout.collapsed, rows, peers,
          header: measure(layout.header) ?? measure(exitingHeader), viewport: layout.viewport() };
      };
      const reconcile = (next, allowed) => {
        const before = snapshot && snapshot.nested === layout?.nested && Date.now() - snapshot.capturedAt < 1000 ? snapshot : null;
        const changed = layout !== null && next.nested !== layout.nested && before?.kind !== 'tree';
        const repairPeers = before?.kind === 'tree' && next.correctNative === true;
        layout = next;
        if (!changed && !repairPeers) {
          for (const [element, animation] of peerMotions) {
            const superseded = !element.isConnected || (element.getAnimations?.() ?? []).some(other => !animations.has(other)
              && (other.effect?.getKeyframes?.() ?? []).some(frame => typeof frame.transform === 'string' && frame.transform.startsWith('translate')));
            if (superseded) {
              animation.onfinish = null; animation.cancel(); animations.delete(animation); peerMotions.delete(element);
            }
          }
          return false;
        }
        // Read the captured visual pose before cancelling interrupted animations.
        clear(); snapshot = null;
        if (changed) for (const row of [...next.rows, next.header].filter(Boolean)) {
          for (const animation of row.getAnimations?.() ?? []) animation.cancel();
          const key = row.getAttribute('data-row-key');
          rowMotions.get(key)?.animation.cancel(); rowMotions.delete(key);
        }
        if (!allowed || !before) return changed;
        // Exit clones belong to the source viewport. A nested target may be shorter
        // or absent under a folded native parent; it must not clip the old title away.
        const viewport = before.viewport ?? next.viewport();
        if (changed && (!viewport?.width || !viewport?.height)) return true;
        const makeOverlay = () => {
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.setAttribute('data-chat-sessions-mode-overlay', '');
            overlay.setAttribute('aria-hidden', 'true'); overlay.inert = true;
            Object.assign(overlay.style, { position: 'fixed', left: `${viewport.left}px`, top: `${viewport.top}px`,
              width: `${viewport.width}px`, height: `${viewport.height}px`, overflow: 'clip', pointerEvents: 'none', zIndex: '5' });
            document.body.append(overlay);
          }
          return overlay;
        };
        const clone = (row, part) => {
          const node = row.element.cloneNode(true);
          for (const element of [node, ...node.querySelectorAll('*')]) {
            element.removeAttribute('id'); element.removeAttribute('data-row-key');
            element.removeAttribute(CLUSTER_HEADER_ATTRIBUTE);
          }
          node.inert = true; node.setAttribute('data-chat-sessions-mode-part', part);
          Object.assign(node.style, { position: 'absolute', margin: '0', transform: 'none', boxSizing: 'border-box',
            left: `${row.rect.left - viewport.left}px`, top: `${row.rect.top - viewport.top}px`,
            width: `${row.rect.width}px`, height: `${row.rect.height}px`,
            font: row.font, color: row.color });
          makeOverlay().append(node); return node;
        };
        const play = (element, frames, exit = false, easing = 'cubic-bezier(0.4, 0, 0.2, 1)') => {
          const animation = element.animate(frames, { duration: GLIDE_MS, easing, fill: 'both' });
          animations.add(animation);
          animation.onfinish = () => {
            animation.onfinish = null; animation.cancel(); animations.delete(animation);
            if (peerMotions.get(element) === animation) peerMotions.delete(element);
            if (exit) element.remove();
            if (!animations.size) clear();
          };
          return animation;
        };
        const peerElements = [...(next.peers?.() ?? [])];
        const peerPaths = [];
        for (const element of peerElements) {
          const previous = before.peers.get(element.getAttribute('data-row-key'));
          if (!previous) continue; // Native entrants keep their own fade.
          const painted = measure(element);
          if (!painted) continue;
          const moves = (element.getAnimations?.() ?? []).filter(animation =>
            (animation.effect?.getKeyframes?.() ?? []).some(frame => typeof frame.transform === 'string' && frame.transform.startsWith('translate')));
          // A correct native FLIP already starts at the captured visual position.
          // Only the intermediate-wrapper mismatch needs replacement on a tree toggle.
          if (!changed && Math.abs(previous.rect.top - painted.rect.top) < 1
            && Math.abs(previous.rect.left - painted.rect.left) < 1) continue;
          for (const animation of moves) animation.cancel();
          const final = measure(element);
          if (!final) continue;
          peerPaths.push({ previous: previous.rect, final: final.rect });
          const dx = previous.rect.left - final.rect.left;
          const dy = previous.rect.top - final.rect.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          peerMotions.set(element, play(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], false,
            changed ? 'cubic-bezier(0.4, 0, 0.2, 1)' : 'ease-out'));
        }
        if (!changed) return false;
        const after = new Map(next.rows.flatMap(element => {
          const row = measure(element);
          return row ? [[element.getAttribute('data-row-key'), row]] : [];
        }));
        const edge = Math.max(0, ...[...after.values()].map(row => row.rect.bottom));
        for (const [key, row] of after) {
          const previous = before.rows.get(key);
          if (previous) {
            play(row.element, [
              { transform: `translate(${previous.rect.left - row.rect.left}px, ${previous.rect.top - row.rect.top}px)`, opacity: previous.opacity, clipPath: previous.clipPath },
              { transform: 'translate(0, 0)', opacity: 1, clipPath: 'inset(0px 0px 0px 0px)' },
            ]);
          } else {
            // A collapsed row has no source rectangle: reveal at its actual native parent.
            const anchor = next.anchor(row.element);
            play(row.element, [
              { clipPath: `inset(0px 0px ${Math.max(0, row.rect.bottom - anchor)}px 0px)`, opacity: 0 },
              { clipPath: `inset(0px 0px ${row.rect.bottom - edge}px 0px)`, opacity: 1 },
            ], false, 'ease-out');
          }
        }
        const exitEdges = new Map();
        for (const [key, row] of before.rows) {
          if (!after.has(key)) exitEdges.set(row.anchor, Math.max(exitEdges.get(row.anchor) ?? row.anchor, row.rect.bottom));
        }
        for (const [key, row] of before.rows) {
          if (after.has(key)) continue;
          const node = clone(row, 'row-exit'); exits.set(key, node);
          // One boundary per source parent retracts the entire block. Incoming peers
          // can also move downward after scroll clamping: clip behind their moving edge.
          const anchor = row.anchor;
          const coverTop = Math.max(0, ...peerPaths.filter(path => path.previous.bottom <= row.rect.top + 1
            && path.final.bottom > path.previous.bottom).map(path => path.final.bottom - row.rect.top));
          play(node, [
            { transform: 'translate(0px, 0px)', clipPath: row.clipPath === 'none'
              ? `inset(0px 0px ${row.rect.bottom - exitEdges.get(anchor)}px 0px)` : row.clipPath, opacity: row.opacity },
            { transform: 'translate(0px, 0px)', clipPath: `inset(${coverTop}px 0px ${Math.max(0, row.rect.bottom - anchor)}px 0px)`, opacity: 0 },
          ]);
        }
        const header = measure(next.header);
        if (before.header && !header) {
          const node = clone(before.header, 'header-exit'); exitingHeader = node;
          const coverTop = Math.max(0, ...peerPaths.filter(path => path.previous.bottom <= before.header.rect.top + 1
            && path.final.bottom > path.previous.bottom).map(path => path.final.bottom - before.header.rect.top + before.header.rect.height / 2));
          play(node, [{ transform: 'translateY(0px)', clipPath: before.header.clipPath, opacity: before.header.opacity },
            { transform: `translateY(${-before.header.rect.height / 2}px)`, clipPath: `inset(${coverTop}px 0px ${before.header.rect.height}px 0px)`, opacity: 0 }], true);
        } else if (header) {
          header.element.setAttribute('data-chat-sessions-mode-decoration', ''); decorations.add(header.element);
          play(header.element, [{
            transform: before.header ? `translate(${before.header.rect.left - header.rect.left}px, ${before.header.rect.top - header.rect.top}px)` : `translateY(${-header.rect.height / 2}px)`,
            clipPath: before.header?.clipPath ?? 'inset(0px 0px 100% 0px)', opacity: before.header?.opacity ?? 0,
          }, { transform: 'translateY(0px)', clipPath: 'inset(0px)', opacity: 1 }]);
        }
        // The divider has its own fade, independent from the header's spatial clipping.
        const lineAt = header ?? before.header;
        if (lineAt) {
          const line = document.createElement('div');
          line.setAttribute('data-chat-sessions-mode-part', header ? 'divider-enter' : 'divider-exit');
          Object.assign(line.style, { position: 'absolute', left: `${lineAt.rect.left - viewport.left}px`,
            top: `${lineAt.rect.top - viewport.top - 6}px`, width: `${lineAt.rect.width}px`,
            borderTop: '1px solid var(--dsw-alias-border-l1)', pointerEvents: 'none' });
          makeOverlay().append(line);
          play(line, [{ opacity: header ? 0 : 1 }, { opacity: header ? 1 : 0 }], true);
        }
        return true;
      };
      return { capture, reconcile, owns: animation => animations.has(animation), reset() { clear(); layout = null; snapshot = null; } };
    }

    // CSS-only cluster folding is invisible to React's row diff. Reveal/retract the
    // cluster from its header edge; surviving rows still use the native 200ms FLIP.
    const clusterMotions = new WeakMap();
    function cancelClusterMotion(container) {
      const motion = clusterMotions.get(container);
      if (!motion) return;
      for (const animation of motion.animations) {
        animation.onfinish = null;
        animation.cancel();
      }
      motion.overlay?.remove();
      clusterMotions.delete(container);
    }
    function foldCluster(container, collapsed, animate) {
      const selector = `[data-row-key], [${CLUSTER_HEADER_ATTRIBUTE}]`;
      const read = () => new Map([...container.querySelectorAll(selector)].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || getComputedStyle(element).display === 'none') return [];
        return [[element, { rect, opacity: Number(getComputedStyle(element).opacity || 1), clipPath: getComputedStyle(element).clipPath }]];
      }));
      const allowed = animate && glideEnabled && glideMotionMode !== 'off'
        && (glideMotionMode === 'force' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true)
        && typeof container.animate === 'function';
      const before = allowed ? read() : new Map();
      const interruptedFrames = new Map();
      for (const [element, clone] of clusterMotions.get(container)?.exits ?? []) {
        const style = getComputedStyle(clone);
        if (style.clipPath && style.clipPath !== 'none') {
          interruptedFrames.set(element, { clipPath: style.clipPath, opacity: Number(style.opacity || 1) });
        }
      }
      cancelClusterMotion(container);
      for (const [key, motion] of rowMotions) {
        if (!container.contains(motion.element)) continue;
        motion.animation.cancel();
        rowMotions.delete(key);
      }
      container.toggleAttribute(CLUSTER_COLLAPSED_ATTRIBUTE, collapsed);
      // The fold owns this transition; the marker's next pass starts from its final layout.
      lastTops.clear(); lastRowPlacements.clear();
      lastRowCount = -1;
      if (!allowed) return;
      const after = read();
      const header = container.querySelector(`[${CLUSTER_HEADER_ATTRIBUTE}]`);
      const expanded = collapsed ? before : after;
      const anchor = expanded.get(header)?.rect.bottom ?? header?.getBoundingClientRect().bottom ?? 0;
      const isClusterRow = (element) => element.matches('[data-row-key^="session:"]')
        && element.closest(`[${GROUP_ATTRIBUTE}]`) !== null;
      const clusterRows = [...expanded].filter(([element]) => isClusterRow(element));
      const edge = Math.max(anchor, ...clusterRows.map(([, row]) => row.rect.bottom));
      // Negative bottom insets let every row share the same moving reveal edge.
      // Using 0 for every endpoint would reveal each row separately at the same time.
      const clipAt = (row, boundary) => `inset(0px 0px ${row.rect.bottom - boundary}px 0px)`;
      const motion = { animations: new Set(), overlay: null, exits: new Map() };
      clusterMotions.set(container, motion);
      const move = (element, frames, duration, exit = false) => {
        const animation = element.animate(frames, { duration, easing: 'ease-out', ...(exit ? { fill: 'forwards' } : {}) });
        motion.animations.add(animation);
        animation.onfinish = () => {
          animation.onfinish = null;
          animation.cancel();
          motion.animations.delete(animation);
          if (exit) element.remove();
          if (motion.animations.size === 0 && clusterMotions.get(container) === motion) {
            motion.overlay?.remove();
            clusterMotions.delete(container);
          }
        };
      };
      for (const [element, row] of after) {
        const previous = before.get(element);
        if (!previous) {
          if (isClusterRow(element)) {
            move(element, [
              { clipPath: interruptedFrames.get(element)?.clipPath ?? clipAt(row, anchor), opacity: interruptedFrames.get(element)?.opacity ?? 0 },
              { clipPath: clipAt(row, edge), opacity: 1 },
            ], GLIDE_MS);
          } else move(element, [{ opacity: 0 }, { opacity: 1 }], 100);
          continue;
        }
        const dx = previous.rect.left - row.rect.left;
        const dy = previous.rect.top - row.rect.top;
        if (dx !== 0 || dy !== 0 || previous.opacity !== 1) {
          move(element, [{ transform: `translate(${dx}px, ${dy}px)`, opacity: previous.opacity }, { transform: 'translate(0, 0)', opacity: 1 }], GLIDE_MS);
        }
      }
      for (const [element, row] of before) {
        if (after.has(element)) continue;
        if (!motion.overlay) {
          const viewport = container.getBoundingClientRect();
          const overlay = document.createElement('div');
          overlay.setAttribute('data-chat-sessions-fold-exits', '');
          overlay.setAttribute('aria-hidden', 'true');
          overlay.inert = true;
          Object.assign(overlay.style, { position: 'fixed', left: `${viewport.left}px`, top: `${viewport.top}px`,
            width: `${viewport.width}px`, height: `${viewport.height}px`, contain: 'strict', pointerEvents: 'none',
            overflow: 'clip', zIndex: '5' });
          (container.parentElement ?? container).appendChild(overlay);
          motion.overlay = overlay;
        }
        const origin = motion.overlay.getBoundingClientRect();
        const clone = element.cloneNode(true);
        clone.removeAttribute('data-row-key');
        for (const node of clone.querySelectorAll('[data-row-key], [id]')) {
          node.removeAttribute('data-row-key');
          node.removeAttribute('id');
        }
        clone.removeAttribute('id');
        clone.inert = true;
        clone.style.setProperty('--dsh-workspace-indent', getComputedStyle(element).getPropertyValue('--dsh-workspace-indent'));
        Object.assign(clone.style, { position: 'absolute', margin: '0', transform: 'none', boxSizing: 'border-box', left: `${row.rect.left - origin.left}px`, top: `${row.rect.top - origin.top}px`, width: `${row.rect.width}px`, height: `${row.rect.height}px` });
        motion.overlay.appendChild(clone);
        if (isClusterRow(element)) {
          motion.exits.set(element, clone);
          move(clone, [
            { clipPath: row.clipPath && row.clipPath !== 'none' ? row.clipPath : clipAt(row, edge), opacity: row.opacity },
            { clipPath: clipAt(row, anchor), opacity: 0 },
          ], GLIDE_MS, true);
        } else move(clone, [{ opacity: row.opacity }, { opacity: 0 }], 100, true);
      }
      if (motion.animations.size === 0) clusterMotions.delete(container);
    }

    /** A plugin-owned row using the native row's layout classes, without cloned host controls. */
    function paintClusterHeader(container, templateRow, label, onCreate, view = {}) {
      if (container === null || templateRow === null) return;
      let header = container.querySelector(`:scope > [${CLUSTER_HEADER_ATTRIBUTE}]`);
      let initial = header === null;
      if (header === null) {
        header = document.createElement('div');
        header.className = templateRow.className;
        header.setAttribute(CLUSTER_HEADER_ATTRIBUTE, '');
        // AnimatedRows snapshots every keyed descendant of its list. A stable
        // plugin key lets this header move on the very same native animation clock.
        header.setAttribute('data-row-key', 'chat-sessions:cluster-header');
        header.setAttribute('role', 'treeitem');
        header.tabIndex = 0;
        header.style.setProperty('--dsh-workspace-indent', '0px');
        // ProjectRowItem: folder slot, overlapping chevron slot, text, trailing actions.
        // Copy only the style shells. None of the host's menu/button/drag handlers belongs here.
        const shell = (index) => templateRow.children[index]?.cloneNode(false) ?? document.createElement('span');
        const folder = shell(0);
        folder.setAttribute('aria-hidden', 'true');
        folder.innerHTML = BADGE_SVG;
        const chevron = shell(1);
        chevron.setAttribute('aria-hidden', 'true');
        chevron.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6 3.5 11 8l-5 4.5z"/></svg>';
        const arrowClass = templateRow.children[1]?.querySelector('svg')?.getAttribute('class');
        if (arrowClass) chevron.firstElementChild.setAttribute('class', arrowClass);
        const text = shell(2);
        const title = templateRow.children[2]?.firstElementChild?.cloneNode(false) ?? document.createElement('span');
        text.appendChild(title);
        const actions = shell(3);
        const nativeAction = templateRow.children[3]?.querySelector('button:last-of-type');
        const action = document.createElement('button');
        action.type = 'button';
        action.className = nativeAction?.className ?? '';
        action.setAttribute(CLUSTER_HEADER_ACTION_ATTRIBUTE, '');
        action.setAttribute('aria-label', '新建会话');
        action.title = '新建会话';
        // Native actions can sit inside different Tooltip/Menu wrappers; never infer glyph by button order.
        action.innerHTML = '<svg data-chat-sessions-new-chat-icon="" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 20.2 3 21l.8-3.2A9.5 9.5 0 1 1 6.2 20.2Z"/><path d="M12 8v8M8 12h8"/></svg>';
        actions.appendChild(action);
        header.append(folder, chevron, text, actions);
        container.appendChild(header);
      }
      const title = header.children[2].firstElementChild;
      if (title.textContent !== label) title.textContent = label;
      if (header.getAttribute('aria-label') !== label) header.setAttribute('aria-label', label);
      const action = header.querySelector(`[${CLUSTER_HEADER_ACTION_ATTRIBUTE}]`);
      const sync = () => {
        if (header.parentElement !== container || !header.isConnected) return;
        const expanded = String(view.collapsed !== true);
        if (header.getAttribute('aria-expanded') !== expanded) header.setAttribute('aria-expanded', expanded);
        if (container.hasAttribute(CLUSTER_COLLAPSED_ATTRIBUTE) !== (view.collapsed === true)) {
          foldCluster(container, view.collapsed === true, !initial);
        }
        header.children[1].firstElementChild.style.transform = view.collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
        action.disabled = view.pending === true;
        action.setAttribute('aria-busy', String(view.pending === true));
        let error = container.querySelector(`:scope > [${CLUSTER_ERROR_ATTRIBUTE}]`);
        if (view.error) {
          if (error === null) {
            error = document.createElement('div');
            error.setAttribute(CLUSTER_ERROR_ATTRIBUTE, '');
            error.setAttribute('role', 'alert');
            container.appendChild(error);
          }
          if (error.textContent !== view.error) error.textContent = view.error;
        } else error?.remove();
      };
      const toggle = () => {
        view.collapsed = !view.collapsed;
        sync();
      };
      header.onclick = toggle;
      header.onkeydown = (event) => {
        if (event.target !== header || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        toggle();
      };
      action.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (view.pending) return;
        view.pending = true;
        view.error = '';
        sync();
        try {
          if (typeof onCreate !== 'function') throw new Error('新建会话服务尚未就绪');
          await onCreate();
          view.collapsed = false;
        } catch (error) {
          view.error = `新建会话失败：${messageOf(error)}`;
        } finally {
          view.pending = false;
          sync();
        }
      };
      sync();
      initial = false;
    }

    /**
     * Mark the receipt-workspace rows of the sidebar.
     *
     * With `ownership: workspace` every standalone session sits inside its own workspace group, so
     * the sidebar would show one folder-ish row per session. The row is an implementation detail:
     * mark it (and its group) so the stylesheet can hide it and zero the group's indentation,
     * leaving the session row as an ordinary top-level row with a single divider above the cluster.
     * @param ids workspace ids that are receipts.
     * @returns a stop function.
     */
    function markReceiptRows(state) {
      if (typeof document === 'undefined' || !document.body) return () => {};
      /** workspaceId -> { pinned, updatedAt }; a Set of ids is still accepted (older callers). */
      const rooms = state.rooms instanceof Map ? state.rooms : new Map();
      const ids = state.ids instanceof Set ? state.ids : new Set(state.ids ?? rooms.keys());
      const untitled = state.untitled;
      /** sessionId set that belongs to a receipt workspace (only needed for the flat list). */
      const standalones = state.standaloneIds instanceof Set ? state.standaloneIds : new Set();
      /** sessionId -> position in the registry's global pin order (0 = newest pin). */
      const pinRanks = state.pinRanks instanceof Map ? state.pinRanks : new Map();
      /** A row we have not classified yet still names itself: our receipts are `session-<uuid>` or a neutral label. */
      const looksReceipt = (row) => {
        const text = row.textContent ?? '';
        return /session-[0-9a-f]{8}-/.test(text) || (untitled !== '' && text.includes(untitled));
      };
      const ROW = '[data-row-key^="workspace:"]';
      // The state was just fetched. Existing foreign rows do not imply a stale receipt set.
      const seenWorkspaceRows = new WeakSet(document.querySelectorAll(ROW));
      /**
       * The shipped row shows a pin indicator (`role="img"`, `aria-label="已置顶"`). Watching it is
       * how a pin/unpin reaches the cluster in ~one frame instead of waiting for the 5 s poll: the
       * click mutates the row, the observer runs, and the pin facts are re-fetched immediately.
       */
      const PIN_INDICATOR = '[class*="pinIndicator"], [role="img"][aria-label="已置顶"]';
      /** last seen native pin state per session row (change detection across observer passes). */
      const pinSeen = new WeakMap();
      /** Rows opened by this marker pass; never re-click a host-controlled row on every mutation. */
      const openedRows = new WeakSet();
      /** Preserve the last confirmed divider while the host is replacing workspace rows. */
      let lastDividerAnchor = null;
      const pendingOpenFrames = new Set();
      const scheduleOpen = (row) => {
        if (row.getAttribute('aria-expanded') !== 'false' || openedRows.has(row)) return;
        openedRows.add(row);
        if (typeof requestAnimationFrame !== 'function') {
          row.click();
          return;
        }
        const frame = requestAnimationFrame(() => {
          pendingOpenFrames.delete(frame);
          if (row.isConnected && row.getAttribute('aria-expanded') === 'false') row.click();
        });
        pendingOpenFrames.add(frame);
      };
      const modeTransition = createModeTransition();
      const captureMode = (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.type === 'keydown' && !['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        if (event.target.closest('[role="menu"], [role^="menuitem"]')) {
          modeTransition.capture();
          return;
        }
        const row = event.target.closest('[data-row-key^="workspace:"][aria-expanded]');
        if (!row || row.closest(`[${GROUP_ATTRIBUTE}]`) || event.target.closest('button, [role="button"]') && event.target.closest('button, [role="button"]') !== row) return;
        modeTransition.capture('tree');
      };
      document.addEventListener('pointerdown', captureMode, true);
      document.addEventListener('click', captureMode, true);
      document.addEventListener('keydown', captureMode, true);
      let trackedSessionStates = new Map();
      const activityOf = (id) => {
        const value = state.activityOf?.(id);
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      };
      const ensure = () => {
        // Capture only active glides before CSS order changes. Reading afterwards
        // includes the new layout delta and makes a rapid reversal jump one row.
        const paintedMotionTops = new Map([...rowMotions].filter(([, motion]) => motion.element.isConnected)
          .map(([key, motion]) => [key, motion.element.getBoundingClientRect().top]));
        // Only ordering facts trigger a pass; token/running/title notifications with
        // unchanged activity do not rescan the sidebar.
        trackedSessionStates = new Map(Array.from(document.querySelectorAll('[data-row-key^="session:"]'), (row) => {
          const id = row.getAttribute('data-row-key').slice('session:'.length);
          return [id, { blank: state.isBlank?.(id) === true, activity: activityOf(id) }];
        }));
        // '单列表' (flat) renders every session as a plain row and no workspace rows at all: the
        // cluster concept does not exist there, so the honest adaptation is to leave the shipped
        // pin/recency order untouched and only publish which rows are standalone sessions. Detected
        // structurally (zero workspace rows next to at least one session row) rather than by the
        // header label, which is localised.
        try {
          if (document.querySelector('[data-row-key="workspace:"]') !== null) classifyBucket();
      const sessionRows = document.querySelectorAll('[data-row-key^="session:"]');
          if (document.querySelector('[data-row-key^="workspace:"]') === null && sessionRows.length > 0) {
            modeTransition.reset();
            document.documentElement.setAttribute(FLAT_ATTRIBUTE, '');
            for (const el of document.querySelectorAll(`[${CLUSTER_HEADER_ATTRIBUTE}], [${CLUSTER_ERROR_ATTRIBUTE}]`)) {
              cancelClusterMotion(el.parentElement);
              el.remove();
            }
            for (const el of document.querySelectorAll(`[${CLUSTER_COLLAPSED_ATTRIBUTE}], [${CLUSTER_DIVIDER_ATTRIBUTE}]`)) {
              el.removeAttribute(CLUSTER_COLLAPSED_ATTRIBUTE);
              el.removeAttribute(CLUSTER_DIVIDER_ATTRIBUTE);
            }
            for (const el of document.querySelectorAll(`[${CONTAINER_ATTRIBUTE}]`)) el.removeAttribute(CONTAINER_ATTRIBUTE);
            for (const el of document.querySelectorAll(`[${GROUP_ATTRIBUTE}]`)) el.removeAttribute(GROUP_ATTRIBUTE);
            for (const el of document.querySelectorAll(`[${FOREIGN_ATTRIBUTE}]`)) el.removeAttribute(FOREIGN_ATTRIBUTE);
            for (const el of document.querySelectorAll(`[${OWNED_ROW_ATTRIBUTE}]`)) el.removeAttribute(OWNED_ROW_ATTRIBUTE);
            let standalone = 0;
            for (const row of sessionRows) {
              const key = (row.getAttribute('data-row-key') ?? '').slice('session:'.length);
              const isStandalone = standalones.has(key);
              row.toggleAttribute(STANDALONE_ATTRIBUTE, isStandalone);
              if (isStandalone) standalone += 1;
            }
            document.documentElement.setAttribute('data-chat-sessions-standalone-count', String(standalone));
            document.documentElement.removeAttribute('data-chat-sessions-flat-error');
            lastTops = new Map();
            lastRowPlacements.clear();
            lastRowCount = -1;
            return;
          }
          document.documentElement.removeAttribute(FLAT_ATTRIBUTE);
          document.documentElement.removeAttribute('data-chat-sessions-standalone-count');
          for (const el of document.querySelectorAll(`[${STANDALONE_ATTRIBUTE}]`)) el.removeAttribute(STANDALONE_ATTRIBUTE);
        } catch (error) {
          document.documentElement.setAttribute('data-chat-sessions-flat-error', String(error && error.message ? error.message : error));
        }
        // The cluster is moved to the bottom with CSS `order`, so DOM order and visual order differ:
        // receipts are registered last-first and therefore sit *first* in the DOM while the stylesheet
        // renders them *last*. The divider is the boundary between the two, which in DOM terms is the
        // bottom edge of the last foreign block — anchoring on "first foreign" instead would follow
        // registration order and end up above the workspaces.
        let clusterStart = null;
        /** True when the cluster block renders inside another workspace's subtree (tree mode). */
        let clusterNested = false;
        let clusterSeen = false;
        let unknown = false;
        /** Keep exactly one glyph on the given session row (idempotent, removed when not needed). */
        /**
         * Keep the hero chip's glyph in step with the picker row: a blank session whose chip
         * already reads "独立对话" must not show a folder. Attribute-gated so we only ever hide
         * the native glyph in that one state.
         */
        const paintChipBadge = (isStandaloneChip) => {
          const chip = document.querySelector('button[aria-label="选择工作区"]');
          if (chip === null) {
            document.documentElement.removeAttribute(CHIP_ATTRIBUTE);
            return;
          }
          const mounted = chip.querySelector(`:scope > [${CHIP_BADGE_ATTRIBUTE}]`);
          if (!isStandaloneChip) {
            document.documentElement.removeAttribute(CHIP_ATTRIBUTE);
            mounted?.remove();
            return;
          }
          document.documentElement.setAttribute(CHIP_ATTRIBUTE, 'standalone');
          if (mounted !== null) return;
          const badge = document.createElement('span');
          badge.setAttribute(CHIP_BADGE_ATTRIBUTE, '');
          badge.setAttribute('aria-hidden', 'true');
          badge.innerHTML = BADGE_SVG;
          chip.prepend(badge);
        };

        const paintRowBadge = (sessionRow) => {
          const existing = sessionRow.querySelector(`:scope > [${BADGE_ELEMENT_ATTRIBUTE}]`);
          if (treeBadge !== 'icon') {
            existing?.remove();
            return;
          }
          if (existing !== null) return;
          const badge = document.createElement('span');
          badge.setAttribute(BADGE_ELEMENT_ATTRIBUTE, '');
          badge.setAttribute('aria-hidden', 'true');
          badge.innerHTML = BADGE_SVG;
          sessionRow.prepend(badge);
        };
        /** Groups we own, with the workspace id they belong to (needed for pin ranking). */
        const ownedGroups = [];
        /** How many owned blocks carried the tree badge this pass (diagnostics only). */
        let badged = 0;
        for (const row of document.querySelectorAll(ROW)) {
          const key = (row.getAttribute('data-row-key') ?? '').slice('workspace:'.length);
          // `''` is the synthetic 「未分组」 bucket: sessions whose workspace was deleted. It is not a
          // workspace, not ours, and must not become the divider anchor.
          if (key === '') {
            const bucketGroup = row.parentElement?.parentElement ?? null;
            if (bucketGroup !== null) {
              bucketGroup.removeAttribute(FOREIGN_ATTRIBUTE);
              bucketGroup.removeAttribute(GROUP_ATTRIBUTE);
            }
            continue;
          }
          const known = ids.has(key);
          const owned = known || looksReceipt(row);
          if (!known && !seenWorkspaceRows.has(row)) unknown = true;
          seenWorkspaceRows.add(row);
          row.toggleAttribute(OWNED_ROW_ATTRIBUTE, owned);
          // `row.parentElement` is a thin wrapper inside the group section; the section itself is the
          // block that owns the inline `--dsh-workspace-indent` and sits next to the sibling groups.
          const group = row.parentElement?.parentElement ?? null;
          if (group === null) continue;
          group.toggleAttribute(GROUP_ATTRIBUTE, owned);
          group.toggleAttribute(FOREIGN_ATTRIBUTE, !owned);
          if (!owned) {
            group.removeAttribute(TREE_BADGE_ATTRIBUTE);
            // A freshly restored session hits the sidebar one beat before its workspace id reaches
            // us. While it looks foreign the divider must not move, so it always rides the *last*
            // foreign block: an unrecognised receipt is prepended, never appended, so the last
            // foreign block stays the same real workspace through the whole transaction.
            clusterStart = group;
            continue;
          }
          // Nesting is a DOM fact, not a path fact: in "按工作区" the same receipt room is a
          // top-level block, while the shipped tree nests it under its path ancestor (`~/.dsh`).
          // Only the tree rendering gets the badge, so a user without such an ancestor never sees
          // a dimmed cluster.
          // The shipped tree states depth as an *inline* custom property on the group section
          // (`--dsh-workspace-indent: depth * 12px`). Our stylesheet zeroes it with `!important`
          // for owned groups, so the inline value is the only surviving trace of nesting — and it
          // is authoritative: `closest(ROW)` cannot see it, because a group section is a *sibling*
          // of the parent's row, not its descendant.
          const depthPx = Number.parseInt(group.style.getPropertyValue('--dsh-workspace-indent') ?? '', 10);
          const nestedInTree = Number.isFinite(depthPx) && depthPx > 0;
          if (!clusterSeen) {
            clusterSeen = true;
            clusterNested = nestedInTree;
          }
          if (nestedInTree && treeBadge !== 'off') group.setAttribute(TREE_BADGE_ATTRIBUTE, treeBadge);
          else group.removeAttribute(TREE_BADGE_ATTRIBUTE);
          if (nestedInTree) {
            badged += 1;
            // The glyph goes on the *session* rows: the workspace row above them is ours and hidden,
            // so the visible evidence of "this is a standalone chat" belongs to the titles.
            for (const sessionRow of group.querySelectorAll('[data-row-key^="session:"]')) {
              paintRowBadge(sessionRow);
            }
          }
          ownedGroups.push({ group, key, row, nested: nestedInTree });
          // A collapsed group renders no session rows, so the hidden row must open itself first.
          if (row.getAttribute('aria-expanded') === 'false') scheduleOpen(row);
        }
        const clusterHasRows = ownedGroups.some(({ group }) => group.querySelector('[data-row-key^="session:"]') !== null);
        // Keep the legacy room-rank diagnostics (only eight display values).
        // Actual row order is computed per session below, across room wrappers.
        const pinnedRooms = ownedGroups
          .filter((entry) => rooms.get(entry.key)?.pinned === true)
          .sort((left, right) => {
            const leftRoom = rooms.get(left.key);
            const rightRoom = rooms.get(right.key);
            const leftPin = leftRoom?.pinIndex ?? Number.MAX_SAFE_INTEGER;
            const rightPin = rightRoom?.pinIndex ?? Number.MAX_SAFE_INTEGER;
            if (leftPin !== rightPin) return leftPin - rightPin;
            return (rightRoom?.updatedAt ?? 0) - (leftRoom?.updatedAt ?? 0);
          });
        // Native indicators belong to this React commit; stale poll ranks cannot
        // resurrect an unpinned row. Within the pin partition, activity wins;
        // registry pin order only breaks ties (including newly pinned cold rows).
        const visiblePins = ownedGroups.flatMap(({ group }) =>
          [...group.querySelectorAll('[data-row-key^="session:"]')])
          .filter((session) => session.querySelector(PIN_INDICATOR) !== null)
          .map((session) => (session.getAttribute('data-row-key') ?? '').slice('session:'.length))
          .sort((left, right) => activityOf(right) - activityOf(left)
            || (pinRanks.get(left) ?? -1) - (pinRanks.get(right) ?? -1));
        const effectivePinRanks = new Map(visiblePins.map((id, index) => [id, index]));
        const ordinaryRows = ownedGroups.flatMap(({ group }) =>
          [...group.querySelectorAll('[data-row-key^="session:"]')])
          .map(session => (session.getAttribute('data-row-key') ?? '').slice('session:'.length))
          .filter(id => !effectivePinRanks.has(id) && state.isBlank?.(id) !== true)
          .sort((left, right) => activityOf(right) - activityOf(left));
        const ordinaryStart = Math.max(100, 3 + visiblePins.length);
        const ordinaryOrders = new Map(ordinaryRows.map((id, index) => [id, ordinaryStart + index]));
        const ranked = new Map(
          pinnedRooms.slice(0, PINNED_RANKS.length).map((entry, index) => [entry.group, rankOf(index)]),
        );
        // FLIP: measure, restamp, then glide every block that actually moved. `ease-out` and 200 ms
        // are the shipped list's numbers so the standalone cluster feels like the rest of the sidebar.
        const motionAllowed = glideMotionMode === 'force'
          ? true
          : glideMotionMode === 'off'
            ? false
            : typeof window === 'undefined'
              || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true;
        const canGlide = glideArmed
          && glideEnabled
          && motionAllowed
          && typeof Element !== 'undefined'
          && typeof Element.prototype.animate === 'function';
        // Membership is diagnostic; flattened survivors animate once from final-layout baselines.
        // The native list retains its opacity-only entry fades.
        const keysNow = ownedGroups.map((entry) => entry.key).sort().join(',');
        const sameBlocks = keysNow === lastBlockKeys;
        lastBlockKeys = keysNow;
        // Final-layout baselines below own the glide. The old before-rect map was used
        // only for its size in diagnostics, forcing layout without contributing to motion.
        let restamped = false;
        let flattenRestamped = false;
        for (const { group, row } of ownedGroups) {
          // The wrapper box has to go for a chat row to outrank another room's chat: `order` only
          // reaches siblings, and the chat rows live *inside* the group box. Set inline (not via the
          // stylesheet) because the shipped group element carries its own inline custom properties
          // and a re-created node must be flattened on the very first pass, not one frame later.
          //
          // "Top-level" is decided by the DOM, not by the indent custom property: the shipped list
          // writes `--dsh-workspace-indent: 12px` on *every* group (ours included), so the custom
          // property cannot tell a cluster room from one nested under a path ancestor — and using it
          // silently left some rooms boxed, which made their chat rows unorderable.
          const nestedInAnotherGroup = group.parentElement !== null
            && group.parentElement.closest(`[${GROUP_ATTRIBUTE}]`) !== null;
          /**
           * Cross-room row ordering is required for the standalone cluster: a newly created
           * session can share a receipt room with a pinned session (fork/new-chat inherits the
           * cwd), and room-level order would let the new unpinned row sit above that pin. The
           * shipped hover preview is re-anchored below when flattening removes the room box.
           */
          const FLATTEN_ROOMS = true;
          if (nestedInAnotherGroup || !FLATTEN_ROOMS) {
            if (group.hasAttribute(FLAT_GROUP_ATTRIBUTE)) group.removeAttribute(FLAT_GROUP_ATTRIBUTE);
            if (group.style.display !== '') group.style.removeProperty('display');
          } else {
            // Every write below is conditional: the pass itself is driven by attribute mutation, so
            // an unconditional `setAttribute`/`style` write would keep waking the observer forever.
            if (!group.hasAttribute(FLAT_GROUP_ATTRIBUTE) || group.style.display !== 'contents') flattenRestamped = true;
            if (!group.hasAttribute(FLAT_GROUP_ATTRIBUTE)) group.setAttribute(FLAT_GROUP_ATTRIBUTE, '');
            if (group.style.display !== 'contents') group.style.display = 'contents';
            // The shipped group wraps its chat rows in one more box (`div` without a row key).
            // Flatten that too, otherwise the rows stay inside a plain block and a row-level
            // `order` is inert.
            for (const child of group.children) {
              if (child.hasAttribute('data-row-key')) continue;
              if (child.style.display !== 'contents') {
                flattenRestamped = true;
                child.style.display = 'contents';
              }
            }
          }
          const next = ranked.get(group) ?? '0';
          if (group.getAttribute(PIN_ATTRIBUTE) !== next) restamped = true;
          group.setAttribute(PIN_ATTRIBUTE, next);
          // The room rank is evidence only. Rows are ranked by their *own* session: a room can hold
          // several chats, and letting the room's rank decide for all of them lifted an unpinned
          // sibling above a pin from another room (report: "较新的会话会把旧的顶掉").
          row.setAttribute(PIN_ATTRIBUTE, next);
          for (const session of group.querySelectorAll('[data-row-key^="session:"]')) {
            const sessionId = (session.getAttribute('data-row-key') ?? '').slice('session:'.length);
            // CSS order reaches across receipt rooms once their wrappers are flattened.
            const pinIndex = effectivePinRanks.get(sessionId);
            const rank = rankOf(pinIndex);
            const blank = state.isBlank?.(sessionId) === true;
            const order = blank ? '2' : pinIndex !== undefined ? String(3 + pinIndex)
              : String(ordinaryOrders.get(sessionId) ?? ordinaryStart);
            session.setAttribute(PIN_ATTRIBUTE, rank);
            session.style.order = order;
            // The shipped list wraps every row in one more box (row -> inline wrapper -> list). That
            // wrapper is the list's flex item, so *it* has to carry the order. It must NOT be
            // collapsed (`display:contents`): the hover card measures the row's wrapper, and a
            // collapsed box reports an all-zero rect, which parks the card in the window corner.
            // The flex item is not always the row: one of the boxes between the row and the list can
            // stay a real box, and then *that* box is what the list lays out. Climb and stamp every
            // box on the way (the row included, it is harmless) until the list itself
            // (`display:flex`) is reached — that parent is the one whose `order` matters.
            let node = session;
            for (let depth = 0; depth < 4 && node !== null; depth += 1) {
              node.style.order = order;
              const parent = node.parentElement;
              if (parent === null || getComputedStyle(parent).display === 'flex') break;
              node = parent;
            }
          }
        }
        // Mark every parent that directly holds a flattened cluster group: those are the boxes whose
        // children are chat rows once the group wrapper is `display:contents`, and `order` only
        // reaches siblings inside one flex container. Mark *all* of them (the shipped list nests
        // rooms in more than one wrapper, and a single "first parent" guess left the marker off some
        // of them, which silently made a row's `order` inert).
        const containers = new Set();
        // One box holds the cluster. Marking every parent (a previous attempt) turned nested
        // wrappers into flex columns and wedged the virtual list, so the first cluster parent wins.
        const firstContainer = ownedGroups[0]?.group.parentElement ?? null;
        if (firstContainer !== null) containers.add(firstContainer);
        for (const el of document.querySelectorAll(`[${CONTAINER_ATTRIBUTE}]`)) {
          if (!containers.has(el)) el.removeAttribute(CONTAINER_ATTRIBUTE);
        }
        for (const el of document.querySelectorAll(`[${CLUSTER_DIVIDER_ATTRIBUTE}]`)) {
          el.removeAttribute(CLUSTER_DIVIDER_ATTRIBUTE);
        }
        for (const container of containers) {
          if (!container.hasAttribute(CONTAINER_ATTRIBUTE)) container.setAttribute(CONTAINER_ATTRIBUTE, '');
          if (!clusterNested && clusterHasRows) container.setAttribute(CLUSTER_DIVIDER_ATTRIBUTE, '');
        }
        for (const header of document.querySelectorAll(`[${CLUSTER_HEADER_ATTRIBUTE}]`)) {
          if (!containers.has(header.parentElement) || clusterNested || !clusterHasRows) {
            cancelClusterMotion(header.parentElement);
            header.remove();
          }
        }
        for (const error of document.querySelectorAll(`[${CLUSTER_ERROR_ATTRIBUTE}]`)) {
          if (!containers.has(error.parentElement) || clusterNested || !clusterHasRows) error.remove();
        }
        for (const el of document.querySelectorAll(`[${CLUSTER_COLLAPSED_ATTRIBUTE}]`)) {
          if (!containers.has(el) || clusterNested || !clusterHasRows) el.removeAttribute(CLUSTER_COLLAPSED_ATTRIBUTE);
        }
        if (!clusterNested && clusterHasRows) {
          const clusterContainer = containers.values().next().value ?? null;
          paintClusterHeader(
            clusterContainer,
            ownedGroups[0]?.row ?? null,
            untitled || '独立对话',
            state.createStandalone,
            state.clusterView,
          );
        }
        let gliding = 0;
        const rowCount = ownedGroups.reduce(
          (total, { group }) => total + group.querySelectorAll('[data-row-key^="session:"]').length,
          0,
        );
        const rowsStable = rowCount === lastRowCount;
        lastRowCount = rowCount;
        // The baseline is now recorded on *every* pass, not only on the passes that animate. Wiping
        // it whenever an animation was skipped (a previous version bailed out as soon as any native
        // animation existed anywhere in the document) meant the next pass had no `previous` for any
        // block, so `data-chat-sessions-glided` stayed 0 forever even while rows visibly moved —
        // report F1. Motion is now suppressed per block, by asking that block's own animations.
        const nativeInside = typeof document.getAnimations === 'function'
          ? document.getAnimations().filter((animation) => {
            const target = animation.effect?.target;
            return target instanceof Element && target.closest(`[${GROUP_ATTRIBUTE}]`) !== null;
          }).length
          : 0;
        // The group box is gone (`display:contents`), so a baseline has to come from its first chat
        // row and the glide has to run on the rows themselves. `offsetTop` ignores transforms, so a
        // baseline survives an animation that is still in flight. The baseline is keyed by that
        // row's own key rather than by the group element: re-sorting the pin order makes React
        // re-create the group sections, and an element-keyed baseline is lost on every reorder —
        // which is exactly when it is needed.
        // Glide measured *per chat row*, not per room: the pin order reorders individual chats inside
        // one list, and a room's first chat row is not a reliable identity (a room whose chats swap
        // places keeps the same first row, so a room-level baseline reports "nothing moved").
        // `offsetTop` ignores transforms, so a baseline survives an animation that is still in flight.
        // Absolute, transform-free Y: pin order reorders whole room boxes, so a row's `offsetTop`
        // (relative to its own room) never changes and the glide reported "nothing moved" — the
        // "隔行置顶没有动画" report. Summing the `offsetParent` chain gives a stable absolute value
        // that still ignores transforms.
        const rowTop = (row) => {
          let y = 0;
          let node = row;
          while (node !== null) {
            y += node.offsetTop;
            node = node.offsetParent;
          }
          return y;
        };
        // Only the flattened cluster rows: every other row in the list belongs to a real workspace
        // group, whose order we never touch.
        // Every chat inside a receipt room glides, whether or not the room boxes are flattened.
        // Filtering on the flatten marker made the list inert the moment flattening was turned off,
        // which is exactly the "置顶时没有动画" report.
        const movable = [...document.querySelectorAll(`[data-row-key^="session:"], [${CLUSTER_HEADER_ATTRIBUTE}][data-row-key]`)]
          .filter((row) => row.hasAttribute(CLUSTER_HEADER_ATTRIBUTE)
            || row.closest(`[${GROUP_ATTRIBUTE}]`) !== null);
        const rowLayout = JSON.stringify(movable.map((row) => [row.getAttribute('data-row-key'), row.style.order]));
        const clusterLayoutChanged = flattenRestamped || rowLayout !== lastRowLayout;
        lastRowLayout = rowLayout;
        // Only reconcile a layout this plugin changed. Native workspace folding
        // already measured final flattened rows using viewport coordinates. Restarting
        // that motion from offsetTop loses scroll clamping and resets its 200ms clock.
        // New receipt wrappers, membership or pin order still need our correction.
        // Native groupBy changes reset AnimatedRows; bridge only a real root/nested
        // transition. A root cluster stays root when unrelated workspaces form a tree.
        const modeRows = movable.filter(row => !row.hasAttribute(CLUSTER_HEADER_ATTRIBUTE));
        const modeHeader = firstContainer?.querySelector(`:scope > [${CLUSTER_HEADER_ATTRIBUTE}]`) ?? null;
        const modeViewport = () => {
          let node = firstContainer ?? document.querySelector('[data-row-key^="workspace:"]')?.parentElement;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (/(auto|scroll|hidden|clip)/.test(`${style.overflowY} ${style.overflow}`)) {
              const rect = node.getBoundingClientRect();
              if (rect.width && rect.height) return rect;
            }
            node = node.parentElement;
          }
          return firstContainer?.getBoundingClientRect() ?? null;
        };
        const modeAnchor = (session) => {
          if (!clusterNested) return modeHeader?.getBoundingClientRect().bottom ?? 0;
          const group = session.closest(`[${GROUP_ATTRIBUTE}]`);
          const parent = group?.parentElement?.closest(`[${FOREIGN_ATTRIBUTE}]`);
          const parentRow = parent?.querySelector(':scope > div > [data-row-key^="workspace:"]')
            ?? parent?.querySelector('[data-row-key^="workspace:"]');
          return parentRow?.getBoundingClientRect().bottom ?? modeViewport()?.top ?? 0;
        };
        // A folded native parent unmounts every owned row. This is still a visual
        // departure from the root cluster, not a teardown of the transition owner.
        // Keep the source capture for its header exit and the later reverse entry.
        const modeChanged = modeTransition.reconcile({
          nested: ownedGroups.length === 0 || clusterNested, collapsed: state.clusterView?.collapsed === true,
          rows: modeRows, header: modeHeader, anchor: modeAnchor, viewport: modeViewport,
          peers: () => [...document.querySelectorAll('[data-row-key^="workspace:"], [data-row-key^="session:"]')]
            .filter(row => row.closest(`[${GROUP_ATTRIBUTE}]`) === null),
          correctNative: clusterNested && flattenRestamped,
        }, canGlide);
        const nestedGroups = new Set(ownedGroups.filter(entry => entry.nested).map(entry => entry.group));
        for (const row of movable) {
          if (modeChanged) continue;
          const flattened = row.hasAttribute(CLUSTER_HEADER_ATTRIBUTE)
            || row.closest(`[${FLAT_GROUP_ATTRIBUTE}]`) !== null;
          const key = row.getAttribute('data-row-key');
          const priorPlacement = lastRowPlacements.get(key);
          const nested = nestedGroups.has(row.closest(`[${GROUP_ATTRIBUTE}]`));
          const reordered = priorPlacement?.element === row && priorPlacement.order !== row.style.order;
          const own = rowMotions.get(key);
          const fold = clusterMotions.get(row.closest(`[${CONTAINER_ATTRIBUTE}]`));
          const nativeMoves = (row.getAnimations?.() ?? []).filter((animation) => {
            if (animation === own?.animation || fold?.animations.has(animation) || modeTransition.owns(animation)) return false;
            return (animation.effect?.getKeyframes?.() ?? []).some((frame) =>
              typeof frame.transform === 'string' && frame.transform.startsWith('translate'));
          });
          // Reopening a native parent remounts/remarks receipt wrappers, but that is
          // not a cluster reorder. Keep native entry fades and viewport FLIP on their
          // original clock. Only a real CSS-order change on a retained nested row is
          // ours; a stale absolute baseline must never become its entry trajectory.
          if (!clusterLayoutChanged || (nested && !reordered)) {
            // A native commit may supersede a still-running plugin pin glide.
            if (own && nativeMoves.length > 0) {
              own.animation.cancel();
              rowMotions.delete(key);
            }
            continue;
          }
          if (flattened) for (const animation of nativeMoves) animation.cancel();
          if (fold || (!flattened && !rowsStable)) continue;
          const previous = lastTops.get(key);
          if (previous === undefined) continue;
          const moved = previous - rowTop(row);
          if (Math.abs(moved) < 1 || !canGlide) continue;
          // A second layout change may arrive during a glide. Continue from the painted
          // position rather than the old target; a no-op refresh leaves the glide alone.
          let from = moved;
          if (own) {
            const visualTop = paintedMotionTops.get(key) ?? own.element.getBoundingClientRect().top;
            own.animation.cancel();
            rowMotions.delete(key);
            if (own.element === row) from = visualTop - row.getBoundingClientRect().top;
          }
          box_animate(row, from);
          gliding += 1;
        }
        const liveKeys = new Set(movable.map((row) => row.getAttribute('data-row-key')));
        for (const [key, motion] of rowMotions) {
          if (canGlide && liveKeys.has(key) && motion.element.isConnected) continue;
          motion.animation.cancel();
          rowMotions.delete(key);
        }
        lastTops = new Map(movable.map((row) => [row.getAttribute('data-row-key'), rowTop(row)]));
        lastRowPlacements = new Map(movable.map(row => [row.getAttribute('data-row-key'), { element: row, order: row.style.order }]));
        // Read by the `glide-state` diagnostic only: the first marked container, if any.
        const containerForBox = containers.values().next().value ?? null;
        // Cheap, permanent diagnostic: how many blocks glided last. Lets a test (and a bug report)
        // prove the reorder animated instead of teleporting, without reading pixels.
        if (gliding > 0) document.documentElement.setAttribute(GLIDE_ATTRIBUTE, String(gliding));
        // Any glyph whose block is no longer a nested standalone block must go (mode switch,
        // archive, 「按工作区」 rendering). Cheap single pass over what we inserted.
        for (const badge of document.querySelectorAll(`[${BADGE_ELEMENT_ATTRIBUTE}]`)) {
          if (badge.closest(`[${TREE_BADGE_ATTRIBUTE}]`) === null) badge.remove();
        }
        document.documentElement.setAttribute('data-chat-sessions-badged', String(badged));
        // The hero chip renders the folder glyph natively; on a standalone blank session it must
        // show the same bubble the picker row and the sidebar rows use.
        const chipLabel = document.querySelector('button[aria-label="选择工作区"]')?.textContent ?? '';
        paintChipBadge(untitled !== undefined && chipLabel.trim() === untitled);
        if (restamped) {
          reportDiagnostics(sameBlocks ? 'reorder' : 'membership');
          runBurst(sameBlocks ? 'reorder' : 'membership');
        }
        if (restamped && !sameBlocks) startBurst();
        if (restamped) {
          // Why a reorder did (or did not) glide: armed / reduced motion / blocks that moved.
          document.documentElement.setAttribute(
            GLIDE_STATE_ATTRIBUTE,
            `armed=${String(glideArmed)} mode=${glideMotionMode} reduced=${String(!motionAllowed)} restamped=true glided=${String(gliding)} candidates=${String(movable.length)} blocks=${sameBlocks ? 'same' : 'changed'} rows=${rowsStable ? 'stable' : 'changed'} native=${String(nativeInside)} box=${containerForBox === null ? 'none' : `${containerForBox.clientHeight}/${containerForBox.scrollHeight}@${Math.round(containerForBox.scrollTop)}`}`,
          );
        }
        // A divider only makes sense between two top-level blocks; nested inside another workspace
        // it would land in the middle of that workspace's own sessions.
        // A divider above the cluster only makes sense when the cluster is a top-level sibling of
        // the workspaces. In tree mode the block sits inside `.dsh`; drawing it there would leave
        // two lines back to back (this one plus the bucket's), so the bucket keeps the single line.
        // The container reserves divider spacing; the header paints the actual line so it
        // shares native movement. Clear the obsolete row-bound anchors for compatibility.
        for (const el of document.querySelectorAll(`[${DIVIDER_ATTRIBUTE}], [${FOREIGN_DIVIDER_ATTRIBUTE}]`)) {
          el.removeAttribute(DIVIDER_ATTRIBUTE);
          el.removeAttribute(FOREIGN_DIVIDER_ATTRIBUTE);
        }
        // Flat rendering: cluster, then 「未分组」. Two blocks need two rules.
        let bucketed = 0;
        for (const bucket of document.querySelectorAll(`[${ORPHAN_BUCKET_ATTRIBUTE}]`)) {
          const isTopLevel = bucket.parentElement?.closest(ROW) == null;
          // Exactly one line between the last workspace block and 「未分组」: the bucket owns it
          // whenever the cluster does not (empty cluster, or nested inside a workspace).
          const after = isTopLevel;
          bucket.toggleAttribute(AFTER_CLUSTER_ATTRIBUTE, after);
          if (after) bucketed += 1;
        }
        document.documentElement.setAttribute('data-chat-sessions-after-cluster-count', String(bucketed));
        // A pin toggle changes only the row's own indicator; without this the cluster would wait up
        // to one poll interval (5 s) before re-ranking, which is what made pinning feel laggy.
        let pinChanged = false;
        for (const { group } of ownedGroups) {
          for (const session of group.querySelectorAll('[data-row-key^="session:"]')) {
            const pinnedNow = session.querySelector(PIN_INDICATOR) !== null;
            const seen = pinSeen.get(session);
            if (seen !== undefined && seen !== pinnedNow) pinChanged = true;
            pinSeen.set(session, pinnedNow);
          }
        }
        // An unclassified workspace row means our id set is stale; refresh it right away instead of
        // waiting for the next poll.
        if (unknown || pinChanged) state.request?.();
        // Report D2: a search result row prints `workspaceLabel(cwd)` in a span with no slot to
        // replace (native component), so the label is rewritten in place. Only a raw
        // `session-<uuid>` (receipt workspace from an older build) or the previous default is
        // touched — real workspace names pass through untouched.
        const label = untitled === '' ? '独立对话' : untitled;
        for (const node of document.querySelectorAll('[class*="searchResultWorkspace"]')) {
          const text = (node.textContent ?? '').trim();
          if (!/^session-[0-9a-f]{8}-/iu.test(text) && text !== '独立会话') continue;
          if (text !== label) node.textContent = label;
        }
      };
      ensure();
      let ensureFrame = 0;
      let markerDisposed = false;
      const sidebarMutationNode = (node) => {
        if (!(node instanceof Element)) return false;
        if (node.closest('[role="tree"]') !== null || node.closest('[data-row-key]') !== null) return true;
        return node.matches('[data-row-key^="workspace:"], [data-row-key^="session:"]')
          || node.querySelector('[data-row-key^="workspace:"], [data-row-key^="session:"]') !== null;
      };
      const scheduleEnsure = () => {
        if (ensureFrame !== 0 || markerDisposed) return;
        ensureFrame = -1;
        queueMicrotask(() => {
          ensureFrame = 0;
          if (!markerDisposed) ensure();
        });
      };
      const unsubscribeSessions = state.sessionList?.subscribe?.(() => {
        for (const [id, previous] of trackedSessionStates) {
          if ((state.isBlank?.(id) === true) !== previous.blank || activityOf(id) !== previous.activity) {
            scheduleEnsure();
            break;
          }
        }
      });
      const observer = new MutationObserver((records) => {
        // The chat transcript also mutates under body. Only sidebar/tree insertions can change the
        // receipt cluster; characterData is deliberately ignored so streaming replies never run a
        // full marker pass.
        if (!records.some((record) => {
          if (record.type !== 'childList') return false;
          if (record.target instanceof Element && record.target.closest(`[${CLUSTER_HEADER_ATTRIBUTE}], [${CLUSTER_ERROR_ATTRIBUTE}], [data-chat-sessions-fold-exits], [data-chat-sessions-mode-overlay]`) !== null) return false;
          const changed = [...record.addedNodes, ...record.removedNodes];
          if (changed.length > 0 && changed.every((node) => node instanceof Element && node.matches('[data-chat-sessions-fold-exits]'))) return false;
          if (sidebarMutationNode(record.target)) return true;
          return [...record.addedNodes, ...record.removedNodes].some(sidebarMutationNode);
        })) return;
        // Reconcile before paint, after React has committed its native row state.
        scheduleEnsure();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      /**
       * Re-anchor the shipped hover preview for cluster rows.
       *
       * Flattening the room box (`display:contents`) is what lets one chat outrank a chat in another
       * room, but it also leaves the shipped preview with an anchor that has no box: it measures
       * `0x0` and parks the card in the top-left corner of the window (report: 「对话信息显示在左上角」).
       * The card itself is still the native one — we only move it back next to the row.
       */
      let hoveredRow = null;
      let lastCard = null;
      let hoverPoint = null;
      let hoverDisposed = false;
      const hoverFrames = new Set();
      const hoverTimers = new Set();
      const watchedCards = new WeakSet();
      const reanchoredCards = new WeakMap();
      const nextHoverFrame = (run) => {
        const frame = window.requestAnimationFrame(() => {
          hoverFrames.delete(frame);
          if (!hoverDisposed) run();
        });
        hoverFrames.add(frame);
      };
      const placeCard = (card) => {
        if (hoverDisposed || card !== lastCard || !card.isConnected || getComputedStyle(card).position !== 'fixed') return;
        const pointedRow = hoverPoint === null ? null
          : document.elementFromPoint?.(hoverPoint.x, hoverPoint.y)?.closest('[data-row-key^="session:"]') ?? null;
        const row = pointedRow ?? (hoveredRow?.isConnected ? hoveredRow : document.querySelector('[data-row-key^="session:"]:hover'));
        if (row === null || !row.isConnected || row.closest(`[${FLAT_GROUP_ATTRIBUTE}]`) === null) return;
        const rect = row.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const cardRect = card.getBoundingClientRect();
        const previous = reanchoredCards.get(card);
        if (cardRect.left > 40 && (!previous || card.style.left !== previous.left || card.style.top !== previous.top)) {
          reanchoredCards.delete(card);
          return;
        }
        const left = `${Math.round(Math.max(8, Math.min(rect.right + 8, window.innerWidth - cardRect.width - 8)))}px`;
        const top = `${Math.round(Math.max(8, Math.min(rect.top, window.innerHeight - cardRect.height - 8)))}px`;
        reanchoredCards.set(card, { left, top });
        cardSizeObserver?.observe(card);
        if (card.style.left !== left) card.style.left = left;
        if (card.style.top !== top) card.style.top = top;
      };
      const cardSizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
        for (const { target } of entries) nextHoverFrame(() => placeCard(target));
      }) : null;
      const cardPositionObserver = new MutationObserver((records) => {
        for (const node of new Set(records.map((record) => record.target))) {
          nextHoverFrame(() => placeCard(node));
        }
      });
      const reanchor = (content) => {
        if (!(content instanceof HTMLElement)) return;
        // Blank sessions have no copyText, hence no copy button role or aria-label. The native
        // SessionHoverContent is shared by blank and named sessions; its floating ancestor is the anchor.
        let node = content;
        while (node !== null && node !== document.body && getComputedStyle(node).position !== 'fixed') node = node.parentElement;
        if (node === null || node === document.body) return;
        if (lastCard !== null && lastCard !== node) cardSizeObserver?.disconnect();
        lastCard = node;
        if (!watchedCards.has(node)) {
          watchedCards.add(node);
          cardPositionObserver.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
        }
        nextHoverFrame(() => placeCard(node));
      };
      const findCards = (root) => {
        if (!(root instanceof HTMLElement)) return;
        if (root.matches('[class*="hoverContent"]')) reanchor(root);
        for (const content of root.querySelectorAll('[class*="hoverContent"]')) reanchor(content);
      };
      function fixVisibleCard() {
        if (hoverDisposed) return;
        if (lastCard !== null && lastCard.isConnected) placeCard(lastCard);
        findCards(document.body);
      }
      const trackHover = (event) => {
        const row = event.target instanceof Element ? event.target.closest('[data-row-key^="session:"]') : null;
        if (typeof event.clientX === 'number' && (event.clientX !== 0 || event.clientY !== 0)) {
          hoverPoint = { x: event.clientX, y: event.clientY };
        }
        if (row === null || (row === hoveredRow && event.type === 'pointermove')) return;
        hoveredRow = row;
        for (const timer of hoverTimers) clearTimeout(timer);
        hoverTimers.clear();
        nextHoverFrame(fixVisibleCard);
        for (const delay of [120, 300, 650]) {
          const timer = setTimeout(() => { hoverTimers.delete(timer); fixVisibleCard(); }, delay);
          hoverTimers.add(timer);
        }
      };
      document.addEventListener('pointerover', trackHover, true);
      document.addEventListener('pointermove', trackHover, true);
      window.addEventListener('resize', fixVisibleCard);
      const cardObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) findCards(node);
      });
      cardObserver.observe(document.body, { childList: true, subtree: true });
      findCards(document.body);
      return () => {
        markerDisposed = true;
        unsubscribeSessions?.();
        observer.disconnect();
        modeTransition.reset();
        document.removeEventListener('pointerdown', captureMode, true);
        document.removeEventListener('click', captureMode, true);
        document.removeEventListener('keydown', captureMode, true);
        cardObserver.disconnect();
        hoverDisposed = true;
        window.removeEventListener('resize', fixVisibleCard);
        cardSizeObserver?.disconnect();
        cardPositionObserver.disconnect();
        for (const frame of hoverFrames) window.cancelAnimationFrame(frame);
        for (const timer of hoverTimers) clearTimeout(timer);
        hoverFrames.clear();
        hoverTimers.clear();
        for (const header of document.querySelectorAll(`[${CLUSTER_HEADER_ATTRIBUTE}]`)) cancelClusterMotion(header.parentElement);
        for (const frame of pendingOpenFrames) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        }
        pendingOpenFrames.clear();
        document.removeEventListener('pointerover', trackHover, true);
        document.removeEventListener('pointermove', trackHover, true);
      };
    }

    /**
     * Receipt workspaces under `<root>/.sessions/`, straight from the host half.
     *
     * Keyed by workspace id and carrying the two facts the sidebar cannot show on a workspace row:
     * whether any session in the room is pinned, and the room's latest activity (used to order
     * several pinned rooms).
     */
    async function receiptWorkspaces(root) {
      try {
        const response = await fetch('/chat-sessions/status', { credentials: 'same-origin' });
        if (!response.ok) return { rooms: new Map(), standaloneIds: new Set(), pinRanks: new Map() };
        const payload = await response.json();
        const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
        const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
        // Reported by the host: a collapsed 「未分组」 renders no rows, so DOM counting alone would
        // mistake "hidden because collapsed" for "empty" and delete the header for good.
        knownOrphans = typeof payload?.orphans === 'number' ? payload.orphans : 0;
        // `/tmp/...` is a symlink to `/private/tmp/...` on macOS and the registry stores the resolved
        // path, so a literal prefix test against the configured root silently matches nothing (that
        // is what made the pin ranking inert in the isolated host). The `.sessions` segment is ours
        // either way, so match on it and keep the root prefix only as the fast path.
        const prefix = `${root}/.sessions/`;
        const rooms = new Map();
        for (const workspace of workspaces) {
          if (typeof workspace?.path !== 'string') continue;
          if (!workspace.path.startsWith(prefix) && !workspace.path.includes('/.sessions/')) continue;
          if (typeof workspace.id !== 'string') continue;
          rooms.set(workspace.id, {
            pinned: workspace.pinned === true,
            // Primary key: the room's newest pin position in the registry's global pin order.
            // The shipped list puts the most recently pinned session on top, so two rooms pinned
            // seconds apart follow that order even when their last activity is minutes apart.
            pinIndex: typeof workspace.pinIndex === 'number' ? workspace.pinIndex : null,
            updatedAt: typeof workspace.updatedAt === 'number' ? workspace.updatedAt : 0,
          });
        }
        // Flat list has no workspace rows at all, so the only handle a verifier has on a standalone
        // session there is its own row — publish the id set for that marking pass.
        const standaloneIds = new Set();
        for (const session of sessions) {
          if (typeof session?.sessionId !== 'string') continue;
          // Keep the room as the *directory*, not the workspace row: an archived room keeps its
          // session but no longer has a workspace, and the flat list still shows that session.
          const cwd = typeof session?.cwd === 'string' ? session.cwd : '';
          if (cwd.startsWith(prefix) || cwd.includes('/.sessions/')) standaloneIds.add(session.sessionId);
        }
        // Per-session pin order. A room may hold several chats (a fork inherits its parent's
        // directory), and the sidebar renders them as sibling rows inside one group wrapper, so
        // ranking the *room* lifted an unpinned chat above a pin from another room. Rows are ranked
        // individually from this list.
        const pinRanks = new Map();
        for (const entry of Array.isArray(payload?.pinOrder) ? payload.pinOrder : []) {
          if (typeof entry?.sessionId !== 'string') continue;
          if (typeof entry?.index !== 'number') continue;
          if (!pinRanks.has(entry.sessionId)) pinRanks.set(entry.sessionId, entry.index);
        }
        return { rooms, standaloneIds, pinRanks };
      } catch {
        return { rooms: new Map(), standaloneIds: new Set() };
      }
    }

    /** Ask the host half whether this option is on (default on). */
    async function readConfig() {
      try {
        const response = await fetch('/chat-sessions/config', { credentials: 'same-origin' });
        if (!response.ok) return { flatten: true, root: '', untitled: '', glide: true, glideMotion: 'auto', treeBadge: 'icon', build: BUILD_TAG };
        const payload = await response.json();
        return {
          flatten: payload?.flattenUngrouped !== false,
          root: typeof payload?.root === 'string' ? payload.root : '',
          untitled: typeof payload?.untitledWorkspaceTitle === 'string' ? payload.untitledWorkspaceTitle : '',
          glide: payload?.glide !== false,
          // `auto` obeys the system setting; `force`/`off` are the explicit overrides (index.js).
          glideMotion: payload?.glideMotion === 'force' || payload?.glideMotion === 'off' ? payload.glideMotion : 'auto',
          treeBadge: payload?.treeBadge === 'tint' || payload?.treeBadge === 'off' ? payload.treeBadge : 'icon',
          build: typeof payload?.build === 'string' && payload.build !== '' ? payload.build : BUILD_TAG,
        };
      } catch {
        return { flatten: true, root: '', untitled: '', glide: true, glideMotion: 'auto', treeBadge: 'icon', build: BUILD_TAG };
      }
    }

    /** Required client services; every key is a real client service in this app. */
    const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace'];

    function apply(ctx) {
      const services = {
        uiWorkspace: ctx.get('uiWorkspace'),
        workspaces: ctx.get('workspaces'),
        sessions: ctx.get('sessions'),
      };
      if (services.sessions?.list && ctx.slots?.entries && ctx.slots?.subscribe) installArchivedBlankBrowser(ctx, services);
      if (typeof document !== 'undefined') document.documentElement.setAttribute(BUILD_ATTRIBUTE, BUILD_TAG);
      ctx.effect(() => insertStyleSheet(`${ungroupedCss()}\n${emptyTurnCss()}`), 'chat-sessions: stylesheet');
      ctx.effect(() => {
        let stopWatching = () => {};
        let stopMarking = () => {};
        let stopProbing = () => {};
        let receiptSignature = null;
        let timer = 0;
        let pending = 0;
        let lastRefresh = 0;
        let disposed = false;
        let refreshInFlight = false;
        let refreshQueued = false;
        let refreshGeneration = 0;
        const clusterView = { collapsed: false, pending: false, error: '' };
        void readConfig().then((config) => {
          if (disposed) return;
          if (typeof document === 'undefined' || !document.documentElement) return;
          buildTag = typeof config.build === 'string' && config.build !== '' ? config.build : BUILD_TAG;
          document.documentElement.setAttribute(BUILD_ATTRIBUTE, buildTag);
          chatRoot = config.root;
          glideEnabled = config.glide !== false;
          glideMotionMode = config.glideMotion === 'force' || config.glideMotion === 'off' ? config.glideMotion : 'auto';
          treeBadge = typeof config.treeBadge === 'string' ? config.treeBadge : 'tint';
          document.documentElement.setAttribute(EMPTY_TURN_ATTRIBUTE, '');
          if (!config.flatten) {
            document.documentElement.removeAttribute(FLATTEN_ATTRIBUTE);
            return;
          }
          document.documentElement.setAttribute(FLATTEN_ATTRIBUTE, '');
          // Receipt rows are keyed by workspace id, which only the host half knows; refresh the set
          // while the sidebar lives so a freshly created session is folded in without a reload.
          /** Re-read the receipt set; throttled because a stale set can ask for it on every mutation. */
          const scheduleRefresh = () => {
            if (pending !== 0) return;
            if (disposed) return;
            if (refreshInFlight) {
              refreshQueued = true;
              return;
            }
            const delay = Math.max(0, 250 - (Date.now() - lastRefresh));
            pending = window.setTimeout(() => {
              pending = 0;
              refresh();
            }, delay);
          };
          const refresh = () => {
            if (disposed) return;
            if (refreshInFlight) {
              refreshQueued = true;
              return;
            }
            refreshInFlight = true;
            const generation = ++refreshGeneration;
            lastRefresh = Date.now();
            void receiptWorkspaces(chatRoot).then(({ rooms, standaloneIds, pinRanks }) => {
              if (disposed || generation !== refreshGeneration) return;
              const signature = JSON.stringify([
                // Room timestamps are diagnostics, not marker identity. Activity
                // comes from the live session list; polling must not tear down a glide.
                [...rooms].map(([id, room]) => [id, room.pinned, room.pinIndex]).sort(([a], [b]) => a.localeCompare(b)),
                [...standaloneIds].sort(),
                [...(pinRanks ?? [])].sort(([a], [b]) => a.localeCompare(b)),
                knownOrphans,
              ]);
              if (signature === receiptSignature) return;
              receiptSignature = signature;
              stopMarking();
              stopMarking = markReceiptRows({
                rooms,
                standaloneIds,
                pinRanks,
                isBlank: (sessionId) => {
                  const summary = services.sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
                  if (summary) return summary.blank === true;
                  return services.sessions?.binding?.(sessionId)?.session?.getSnapshot?.()?.blank === true;
                },
                activityOf: (sessionId) => {
                  const summary = services.sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
                  return summary?.updatedAt
                    ?? services.sessions?.binding?.(sessionId)?.session?.getSnapshot?.()?.updatedAt;
                },
                sessionList: services.sessions?.list,
                untitled: config.untitled,
                clusterView,
                createStandalone: async () => {
                  if (typeof services.uiWorkspace?.openSession !== 'function') {
                    throw new Error('会话导航服务尚未就绪');
                  }
                  const response = await fetch('/chat-sessions/create', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{"reuseBlank":true}',
                    credentials: 'same-origin',
                  });
                  const payload = await response.json().catch(() => null);
                  if (!response.ok || payload?.ok !== true || typeof payload?.sessionId !== 'string') {
                    throw new Error(typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`);
                  }
                  await services.uiWorkspace.openSession(payload.sessionId);
                  scheduleRefresh();
                },
                request: scheduleRefresh,
              });
            }).finally(() => {
              refreshInFlight = false;
              if (!disposed && refreshQueued) {
                refreshQueued = false;
                refresh();
              }
            });
          };
          stopProbing = startMotionProbe();
          refresh();
          timer = window.setInterval(refresh, 5000);
        });
        return () => {
          disposed = true;
          refreshGeneration += 1;
          refreshQueued = false;
          stopWatching();
          stopMarking();
          stopProbing();
          for (const motion of rowMotions.values()) motion.animation.cancel();
          rowMotions.clear();
          lastTops.clear(); lastRowPlacements.clear();
          for (const el of document.querySelectorAll(`[${CLUSTER_HEADER_ATTRIBUTE}], [${CLUSTER_ERROR_ATTRIBUTE}]`)) {
              cancelClusterMotion(el.parentElement);
              el.remove();
            }
          for (const el of document.querySelectorAll(`[${CLUSTER_COLLAPSED_ATTRIBUTE}]`)) el.removeAttribute(CLUSTER_COLLAPSED_ATTRIBUTE);
          if (pending !== 0) window.clearTimeout(pending);
          if (timer !== 0) window.clearInterval(timer);
        };
      }, 'chat-sessions: flatten the sidebar');

      const primitives = readPrimitives();
      if (!primitives) {
        ctx.logger?.warn?.('[chat-sessions] primitives unavailable; the shipped workspace picker stays in charge');
        return;
      }

      if (!services.uiWorkspace || !services.workspaces) {
        ctx.logger?.warn?.('[chat-sessions] uiWorkspace/workspaces missing; picker entry not registered');
        return;
      }

      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'chat-sessions: dictionaries');

      const HeroWorkspaceMenu = createHeroWorkspaceMenu(primitives, services);

      ctx.slots.inject(HERO_PICKER_SLOT, () =>
        ctx.slots.register(
          {
            name: HERO_PICKER_SLOT,
            priority: -100,
            locale: NS,
          },
          HeroWorkspaceMenu,
        ),
      );
    }

    // `dictionaries` + the CSS builders are exported for check.mjs (locale parity
    // and the two stylesheets); the client fiber only reads `inject` and `apply`.
    return {
      projectArchivedBlanks,
      installArchivedBlankBrowser,
      dictionaries,
      inject,
      apply,
      ungroupedCss,
      emptyTurnCss,
      FLATTEN_ATTRIBUTE,
      EMPTY_TURN_ATTRIBUTE,
      STYLE_ID,
    };
  },
});
