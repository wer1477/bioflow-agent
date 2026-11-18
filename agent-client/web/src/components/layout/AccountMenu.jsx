import { useCallback, useEffect, useRef, useState } from 'react';
import { LockIcon, LogoutIcon, MessageIcon, SettingsIcon, SlidersIcon, UserIcon } from '../common/icons.jsx';

const MENU_ID = 'account-menu';
const SETTINGS_ITEMS = [
  { id: 'general', label: '通用设置', Icon: SlidersIcon },
  { id: 'agent', label: 'Agent 设置', Icon: SettingsIcon },
];

/**
 * 侧栏底部的账户入口。
 *
 * 鉴权关闭（开发实例）时保持原样：只有「通用设置 / Agent 设置」两项。
 * 鉴权打开时在顶部显示当前邮箱与角色，并追加「意见反馈 / 修改密码 / 退出登录」；
 * 反馈弹窗由 Root 统一渲染。
 * 菜单固定向上弹出；键盘按 role="menu" 的常规约定：↑↓ 移动、Home/End 首尾、Esc 关闭并回焦。
 */
export function AccountMenu({ settingsSection, onOpenSettings, account }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const authenticated = Boolean(account?.enabled && account?.user);
  const items = authenticated
    ? [
      ...SETTINGS_ITEMS,
      { id: 'feedback', label: '意见反馈', Icon: MessageIcon, action: () => account.onFeedback?.() },
      { id: 'change-password', label: '修改密码', Icon: LockIcon, action: account.onChangePassword },
      { id: 'logout', label: '退出登录', Icon: LogoutIcon, action: account.onLogout },
    ]
    : SETTINGS_ITEMS;

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // 外部点击关闭：pointerdown 同时覆盖鼠标与触摸。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 打开时焦点落在第一项，键盘用户不必先 Tab 一圈。
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const focusItem = (index) => {
    const rows = itemRefs.current.filter(Boolean);
    if (!rows.length) return;
    rows[(index + rows.length) % rows.length].focus();
  };

  const handleKeyDown = (event) => {
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    // Tab 不是菜单内的移动方式：关掉菜单，让焦点自然离开。
    if (event.key === 'Tab') {
      close();
      return;
    }
    const rows = itemRefs.current.filter(Boolean);
    const current = rows.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(rows.length - 1);
    }
  };

  const choose = (item) => {
    close();
    if (item.action) item.action();
    else onOpenSettings(item.id);
  };

  return (
    <div className="account-menu-root" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        className="account-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
        aria-label="账户"
        title={authenticated ? account.user.email : '账户'}
        onClick={() => setOpen((value) => !value)}
      >
        <UserIcon />
        <span className="account-trigger-label">账户</span>
      </button>
      {open && (
        <div className="account-menu" id={MENU_ID} role="menu" aria-label="账户">
          {authenticated && (
            <div className="account-menu-user">
              <strong title={account.user.email}>{account.user.email}</strong>
              <span>{account.user.role === 'admin' ? '管理员' : '普通用户'}</span>
            </div>
          )}
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { itemRefs.current[index] = node; }}
              className="account-menu-item"
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-current={settingsSection === item.id ? 'page' : undefined}
              onClick={() => choose(item)}
            >
              <item.Icon />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
