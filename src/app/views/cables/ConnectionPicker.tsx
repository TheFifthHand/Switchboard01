/**
 * Keyboard connection picker for one socket.
 *
 * Enter on an output opens "Connect <module> <port> to…": a listbox of every
 * input it can legally reach (this part, the shared returns, other parts),
 * followed by the cables already leaving that output, each with Disconnect.
 * Enter on an input lists the cables arriving there with Disconnect, and the
 * outputs that could feed it. Arrow keys move through the list, Enter
 * connects, Escape closes and returns focus to the socket.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton, NumberField } from '../../../ui/components';
import { compatibleSources, compatibleTargets } from '../../../project/graph';
import type { Connection, Id, PortRef } from '../../../project/types';
import { session, useProject } from '../../instance';
import { cableName, connectionKindOf, endpointName, refOfKey, type ModuleInfo, type TrackInfo } from './model';
import styles from './CablePanel.module.css';

export interface ConnectionPickerProps {
  socketKey: string;
  anchor: HTMLElement | null;
  trackId: Id;
  modules: readonly ModuleInfo[];
  tracks: readonly TrackInfo[];
  locked: boolean;
  onClose(refocus: boolean): void;
  /** Connect and report the outcome; returns an error message when refused. */
  onConnect(from: PortRef, to: PortRef): string | null;
  onDisconnect(connectionId: Id): void;
  onAmount(connectionId: Id, amount: number, gesture: string): void;
}

interface Option {
  id: string;
  ref: PortRef;
  /** Full name ("Bass Filter Cutoff mod"). */
  label: string;
  /** Name within its group ("Filter Cutoff mod"). */
  short: string;
}

interface Group {
  label: string;
  options: Option[];
}

const selectConnections = (p: { patch: { connections: Connection[] } }) => p.patch.connections;

export function ConnectionPicker(props: ConnectionPickerProps) {
  const { socketKey, anchor, trackId, modules, tracks, locked, onClose, onConnect, onDisconnect, onAmount } = props;
  const { ref: self, dir } = refOfKey(socketKey);
  const connections = useProject(selectConnections);
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const selfName = endpointName(modules, self, dir, tracks, trackId);
  const title = dir === 'out' ? `Connect ${selfName} to…` : `Connect ${selfName} from…`;

  const groups = useMemo<Group[]>(() => {
    const patch = session.store.getState().patch;
    const refs = dir === 'out' ? compatibleTargets(patch, self) : compatibleSources(patch, self);
    const byGroup = new Map<string, Option[]>();
    const orderKey = (m: ModuleInfo | undefined) => (!m ? 'zz' : m.trackId === trackId ? '0' : !m.trackId ? '1' : `2${String(tracks.findIndex((t) => t.id === m.trackId)).padStart(2, '0')}`);
    const labelOf = (m: ModuleInfo | undefined) => (!m ? 'Other' : m.trackId === trackId ? 'This part' : !m.trackId ? 'Shared' : (tracks.find((t) => t.id === m.trackId)?.name ?? 'Other part'));
    const keyed: { key: string; label: string; opt: Option }[] = refs.map((r, i) => {
      const m = modules.find((x) => x.id === r.module);
      const otherDir = dir === 'out' ? 'in' : 'out';
      return {
        key: orderKey(m),
        label: labelOf(m),
        opt: { id: `${baseId}-o${i}`, ref: r, label: endpointName(modules, r, otherDir, tracks, trackId), short: endpointName(modules, r, otherDir, tracks, m?.trackId ?? trackId) },
      };
    });
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const out: Group[] = [];
    for (const k of keyed) {
      let list = byGroup.get(k.label);
      if (!list) {
        list = [];
        byGroup.set(k.label, list);
        out.push({ label: k.label, options: list });
      }
      list.push(k.opt);
    }
    return out;
    // connections: recompute when cables change (a new cable removes its duplicate option).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketKey, connections, modules, tracks, trackId, baseId]);
  const options = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  const cables = useMemo(
    () => connections.filter((c) => (dir === 'out' ? c.from.module === self.module && c.from.port === self.port : c.to.module === self.module && c.to.port === self.port)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, socketKey],
  );

  useEffect(() => {
    if (active >= options.length) setActive(Math.max(0, options.length - 1));
  }, [options.length, active]);

  // Place next to the socket, inside the viewport.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const w = el.offsetWidth;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const wantH = Math.min(el.scrollHeight, 380);
    const useBelow = below >= Math.min(wantH, 220) || below >= above;
    const maxHeight = Math.max(160, Math.min(380, useBelow ? below : above));
    const top = useBelow ? r.bottom + 6 : Math.max(8, r.top - 6 - Math.min(wantH, maxHeight));
    const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
    setPos({ left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxHeight) });
  }, [anchor, options.length, cables.length]);

  // Focus the list (or the first button) when opened.
  useEffect(() => {
    const target = listRef.current ?? rootRef.current?.querySelector<HTMLElement>('button:not([disabled])') ?? rootRef.current;
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on a pointer press outside, or when focus leaves.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || rootRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose(false);
    };
    // The picker is placed next to its socket; if the page or the patch area moves, it closes.
    const onMoved = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMoved);
    window.addEventListener('scroll', onMoved, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMoved);
      window.removeEventListener('scroll', onMoved, true);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    document.getElementById(options[active]?.id ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [active, options]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || locked) return;
    const [from, to] = dir === 'out' ? [self, o.ref] : [o.ref, self];
    const err = onConnect(from, to);
    if (err) setError(err);
    else onClose(true);
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!options.length) return;
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(last);
        break;
      case 'PageDown':
        setActive((a) => Math.min(last, a + 8));
        break;
      case 'PageUp':
        setActive((a) => Math.max(0, a - 8));
        break;
      case 'Enter':
      case ' ':
        choose(active);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && (rootRef.current?.contains(to) || anchor === to)) return;
    if (to) onClose(false);
  };

  const listLabelId = `${baseId}-title`;
  const cablesLabel = dir === 'out' ? 'Cables from this socket' : 'Cables into this socket';

  const listbox = (
    <section className={styles.pickerSection} aria-label={dir === 'out' ? 'Destinations' : 'Sources'}>
      <h4 className={styles.pickerHeading}>{dir === 'out' ? 'Connect to' : 'Connect from'}</h4>
      {options.length === 0 ? (
        <p className={styles.pickerEmpty}>{dir === 'out' ? 'Nothing else can take this cable right now.' : 'No free output can feed this socket right now.'}</p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          className={styles.pickerList}
          aria-labelledby={listLabelId}
          aria-activedescendant={options[active]?.id}
          aria-disabled={locked || undefined}
          onKeyDown={onListKey}
        >
          {groups.map((g, gi) => (
            <div role="group" key={g.label} aria-labelledby={`${baseId}-g${gi}`}>
              <div id={`${baseId}-g${gi}`} role="presentation" className={styles.pickerGroup}>
                {g.label}
              </div>
              {g.options.map((o) => {
                const i = options.indexOf(o);
                return (
                  <div
                    key={o.id}
                    id={o.id}
                    role="option"
                    aria-label={o.label}
                    aria-selected={i === active}
                    className={styles.pickerOption}
                    data-kind={connectionKindOf(modules, { from: dir === 'out' ? self : o.ref })}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setActive(i);
                      choose(i);
                    }}
                  >
                    <span className={styles.pickerDot} aria-hidden="true" />
                    {o.short}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );

  const existing = (
    <section className={styles.pickerSection} aria-label={cablesLabel}>
      <h4 className={styles.pickerHeading}>{cablesLabel}</h4>
      {cables.length === 0 ? (
        <p className={styles.pickerEmpty}>No cables yet.</p>
      ) : (
        <ul className={styles.pickerCables}>
          {cables.map((c) => {
            const name = cableName(modules, c, tracks, trackId);
            const mod = connectionKindOf(modules, c) === 'mod';
            return (
              <li key={c.id} className={styles.pickerCable} data-kind={mod ? 'mod' : 'audio'}>
                <span className={styles.pickerCableName}>{name}</span>
                {mod && (
                  <NumberField
                    label={`Amount of ${name}`}
                    hideLabel
                    layout="inline"
                    size="sm"
                    chars={4}
                    min={-100}
                    max={100}
                    step={1}
                    unit="%"
                    value={Math.round((c.amount ?? 1) * 100)}
                    disabled={locked}
                    onChange={(v, info) => onAmount(c.id, v / 100, info.gesture)}
                  />
                )}
                <Button size="sm" variant="ghost" disabled={locked} aria-label={`Disconnect ${name}`} onClick={() => onDisconnect(c.id)}>
                  Disconnect
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={listLabelId}
      className={styles.picker}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: -9999, top: 0 }}
      tabIndex={-1}
      onKeyDown={onRootKey}
      onBlur={onBlur}
    >
      <header className={styles.pickerHead}>
        <h3 id={listLabelId} className={styles.pickerTitle}>
          {title}
        </h3>
        <IconButton icon="close" label="Close" size="sm" onClick={() => onClose(true)} />
      </header>
      {locked && <p className={styles.pickerError}>Patching is locked while a performance is being recorded.</p>}
      {error && (
        <p className={styles.pickerError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.pickerBody}>
        {dir === 'out' ? (
          <>
            {listbox}
            {existing}
          </>
        ) : (
          <>
            {existing}
            {listbox}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
