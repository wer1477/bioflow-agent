import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../common/icons.jsx';
import {
  effortLevels,
  isRoutable,
  modelCount,
  modelLabel,
  providerGroups,
  sameSelection,
  triggerLabel,
} from '../../domain/model_selection.js';

/** The panel has a fixed footprint: its position is computed before it renders. */
const MENU_WIDTH = 320;
/** Below this many models a search box is one more thing to skip past. */
const SEARCH_THRESHOLD = 4;

/**
 * The composer's model picker: model name + thinking level on the trigger, a two-row root
 * menu ("模型" / "思考强度") that drills into a provider-grouped model list or the level list.
 *
 * The shape follows DSH's composer seat (`ModelSelect`): the trigger shows exactly what is
 * in force, one row per dimension, and a search box only once the catalog is long enough to
 * need one. What DSH does not have and this does is the "跟随角色" row: our selection sits on
 * top of a durable per-role binding, so it has to be able to step back down.
 *
 * Selection state is NOT kept here. The backend resolves which provider/model/level the role
 * runs with and reports it in the team view; this component only renders it and asks the
 * parent to write a change.
 */
export function ModelPicker({ llm, catalog, roleLabel, disabled, onSelect, onClear }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState('root');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [placement, setPlacement] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);

  // The composer clips its children (`.composer { overflow: hidden }`), so the panel is
  // portalled to the body and pinned above the trigger by viewport coordinates.
  const placeMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') return;
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    setPlacement({
      width,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    });
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPane('root');
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [open, close, placeMenu]);

  useEffect(() => {
    if (open && pane === 'model' && modelCount(catalog) > SEARCH_THRESHOLD) {
      searchRef.current?.focus();
    }
  }, [open, pane, catalog]);

  const selection = llm?.selection || null;
  const levels = useMemo(() => effortLevels(catalog, selection), [catalog, selection]);
  const groups = useMemo(() => providerGroups(catalog, query), [catalog, query]);
  const showSearch = modelCount(catalog) > SEARCH_THRESHOLD;
  const effectiveLabel = triggerLabel(catalog, selection);
  const routable = isRoutable(catalog, llm);
  const hasOverride = Boolean(llm?.override);
  const title = [
    `选择模型，当前 ${effectiveLabel}`,
    roleLabel ? `作用于 ${roleLabel}` : '',
    hasOverride ? '本会话已覆盖' : '',
    routable ? '' : '该模型当前不可用',
  ].filter(Boolean).join('；');

  // A selection that cannot run must not look healthy: the run would fail with an
  // unknown-provider/model error the user could have seen here.
  const triggerClass = `model-trigger${routable ? '' : ' is-stale'}${busy ? ' is-busy' : ''}`;

  const submit = async (payload) => {
    if (!onSelect) return;
    setBusy(true);
    try {
      const changed = await onSelect(payload);
      if (changed !== false) close(true);
    } catch {
      // The parent reports the failure; leaving the menu open lets the user pick again.
    } finally {
      setBusy(false);
    }
  };

  const chooseModel = (providerId, model) => {
    const candidate = { providerId, modelId: model.id, ...levelFor(selection?.thinkingLevel, model) };
    if (sameSelection(selection, candidate)) {
      close(true);
      return;
    }
    submit(candidate);
  };

  const chooseEffort = (level) => {
    if (!selection) return;
    const candidate = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(level ? { thinkingLevel: level } : {}),
    };
    if (sameSelection(selection, candidate)) {
      close(true);
      return;
    }
    submit(candidate);
  };

  const chooseFollow = async () => {
    if (!hasOverride) {
      close(true);
      return;
    }
    if (!onClear) return;
    setBusy(true);
    try {
      const changed = await onClear();
      if (changed !== false) close(true);
    } catch {
      // Same as a failed selection: stay open, the parent explains why.
    } finally {
      setBusy(false);
    }
  };

  /** One drill level up; the trigger is a menu, not a modal, so Escape unwinds rather than closes. */
  const unwind = () => {
    if (pane !== 'root') {
      setPane('root');
      return;
    }
    close(true);
  };

  const onMenuKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      unwind();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"], [role="menuitem"]') || [])]
      .filter((node) => !node.disabled);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  if (!llm || !selection) return null;

  return (
    <div className="model-seat" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        disabled={disabled || busy}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          placeMenu();
          setOpen(true);
        }}
      >
        <span className="model-trigger-label">{modelLabel(catalog, selection)}</span>
        {selection.thinkingLevel && <span className="model-trigger-effort">{selection.thinkingLevel}</span>}
        <ChevronDownIcon className={`model-trigger-chevron${open ? ' is-open' : ''}`} />
      </button>

      {open && placement && createPortal(
        <div
          className="model-menu"
          ref={menuRef}
          role="menu"
          aria-label="模型与思考强度"
          style={{ width: placement.width, left: placement.left, bottom: placement.bottom }}
          onKeyDown={onMenuKeyDown}
        >
          {pane !== 'root' && (
            <button
              type="button"
              role="menuitem"
              className="model-menu-back"
              onClick={() => setPane('root')}
            >
              <ChevronLeftIcon />
              <span>{pane === 'model' ? '模型' : '思考强度'}</span>
            </button>
          )}

          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className="model-cell" onClick={() => setPane('model')}>
                <span className="model-cell-label">模型</span>
                <span className="model-cell-value">{modelLabel(catalog, selection)}</span>
                <ChevronRightIcon />
              </button>
              {levels.length > 0 && (
                <button type="button" role="menuitem" className="model-cell" onClick={() => setPane('effort')}>
                  <span className="model-cell-label">思考强度</span>
                  <span className="model-cell-value">{selection.thinkingLevel || '默认'}</span>
                  <ChevronRightIcon />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && (
                <div className="model-search-row">
                  <input
                    type="search"
                    ref={searchRef}
                    className="model-search"
                    aria-label="搜索模型"
                    placeholder="搜索模型…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    // The menu lives inside the composer <form>: Enter in a text field would
                    // submit the draft message instead of doing nothing.
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                  />
                </div>
              )}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!hasOverride}
                className={`model-option model-option-follow${hasOverride ? '' : ' is-checked'}`}
                onClick={chooseFollow}
              >
                <span className="model-option-copy">
                  <span className="model-option-label">跟随角色</span>
                  <small className="model-option-hint">{roleLabel ? `${roleLabel} 的默认配置` : '角色的默认配置'}</small>
                </span>
                {!hasOverride && <CheckIcon />}
              </button>
              <div className="model-groups">
                {groups.map((group) => (
                  <div className="model-group" key={group.id}>
                    <p className="model-group-head">{group.name}</p>
                    {group.models.map((model) => {
                      const checked = !hasOverride
                        && selection.providerId === group.id
                        && selection.modelId === model.id;
                      return (
                        <button
                          key={`${group.id}\u0000${model.id}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={checked}
                          className={`model-option${checked ? ' is-checked' : ''}`}
                          data-provider-id={group.id}
                          data-model-id={model.id}
                          onClick={() => chooseModel(group.id, model)}
                        >
                          <span className="model-option-label">{model.label}</span>
                          {checked && <CheckIcon />}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {!groups.length && <p className="model-empty" role="status">没有匹配的模型。</p>}
              </div>
            </>
          )}

          {pane === 'effort' && (
            <>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!selection.thinkingLevel}
                className={`model-option${selection.thinkingLevel ? '' : ' is-checked'}`}
                onClick={() => chooseEffort('')}
              >
                <span className="model-option-label">默认（不指定）</span>
                {!selection.thinkingLevel && <CheckIcon />}
              </button>
              {levels.map((level) => {
                const checked = selection.thinkingLevel === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    className={`model-option${checked ? ' is-checked' : ''}`}
                    onClick={() => chooseEffort(level)}
                  >
                    <span className="model-option-label">{level}</span>
                    {checked && <CheckIcon />}
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Keep the current effort when the new model declares it; otherwise take that model's first
 * declared level. A level left over from the previous model would be rejected by the backend
 * as `unknown-level`, and the user never chose it.
 */
function levelFor(currentLevel, model) {
  const declared = model.thinkingLevels || [];
  if (!declared.length) return {};
  return { thinkingLevel: currentLevel && declared.includes(currentLevel) ? currentLevel : declared[0] };
}
