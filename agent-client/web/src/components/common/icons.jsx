// 共享图标组件：统一尺寸、统一描边样式（继承当前文字颜色）。
// 约定：viewBox 0 0 24 24、fill=none、stroke=currentColor，尺寸由 CSS 控制
// （见 styles.css 的 .icon svg 规则），组件本身不带 width/height。

function Icon({ children }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

// 侧栏 / 菜单通用操作图标。这四个曾是裸 <svg>（没有 fill/stroke/.icon），
// 只在部分容器里靠 CSS 兜底尺寸；换到没有兜底的容器（项目菜单、GoalDock）就会
// 撑成巨大的黑色实心块。统一走 Icon 后尺寸与描边由 .icon 决定。
export function EditIcon() {
  return <Icon><path d="m4 16 9.8-9.8 3.2 3.2L7.2 19H4zM12.7 7.3l3.2 3.2M15.4 4.6l1.2-1.2a1.8 1.8 0 0 1 2.6 2.6L18 7.2" /></Icon>;
}

export function PinIcon() {
  return <Icon><path d="m9 4 6 6 2-1 1 1-3 3 1 4-1 1-4-1-3 3-1-1 1-2-6-6 7-7Z" /></Icon>;
}

export function TrashIcon() {
  return <Icon><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></Icon>;
}

export function CopyMessageIcon() {
  return <Icon><rect x="8" y="8" width="10" height="10" rx="2" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></Icon>;
}

// ── 工具卡片图标（B 批） ────────────────────────────────────────────

export function TerminalIcon() {
  return <Icon><path d="m5 8 3 3-3 3M12 15h6" /><rect x="3" y="4" width="18" height="16" rx="2" /></Icon>;
}

export function CodeIcon() {
  return <Icon><path d="m9 8-4 4 4 4M15 8l4 4-4 4" /></Icon>;
}

export function DiffIcon() {
  return <Icon><path d="M12 4v7M8.5 7.5h7M8.5 16.5h7" /></Icon>;
}

export function FileIcon() {
  return <Icon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Icon>;
}

export function SearchIcon() {
  return <Icon><circle cx="11" cy="11" r="6" /><path d="m20 20-4.3-4.3" /></Icon>;
}

export function WebIcon() {
  return <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></Icon>;
}

export function PlanIcon() {
  return <Icon><path d="M9 6h10M9 12h10M9 18h10M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></Icon>;
}

export function CapabilityIcon() {
  return <Icon><path d="M12 3 4 7v10l8 4 8-4V7z" /><path d="M12 12 4 7M12 12l8-5M12 12v9" /></Icon>;
}

export function GenericIcon() {
  return <Icon><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>;
}

/** 思维链行：四角星，读作「模型在想」。 */
export function ThinkingIcon() {
  return <Icon><path d="M11 4.5 12.4 8.6 16.5 10 12.4 11.4 11 15.5 9.6 11.4 5.5 10 9.6 8.6z" /><path d="m17.5 14.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></Icon>;
}

/** 系统提示词行：分层上下文。 */
export function ContextIcon() {
  return <Icon><path d="m12 3.5 8 4-8 4-8-4z" /><path d="m4 12 8 4 8-4M4 16.5l8 4 8-4" /></Icon>;
}

/** 会话统计：仪表盘，读作「轮次 / 速度」。 */
export function GaugeIcon() {
  return <Icon><path d="M4.2 18.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 14 3.8-4.2" /><circle cx="12" cy="14.5" r="1.3" /></Icon>;
}

/** 会话统计：数据库，读作「token 用量」。 */
export function DatabaseIcon() {
  return <Icon><ellipse cx="12" cy="5.5" rx="7" ry="2.5" /><path d="M5 5.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" /><path d="M5 11.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" /></Icon>;
}

export function ChevronRightIcon() {
  return <Icon><path d="m10 6 6 6-6 6" /></Icon>;
}

export function CheckIcon() {
  return <Icon><path d="m5 13 4 4L19 7" /></Icon>;
}

/** 全宽预览 / 还原：一对镜像箭头，语义是"放大到全宽"与"收回原来宽度"。 */
export function ExpandIcon() {
  return <Icon><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></Icon>;
}

export function RestoreIcon() {
  return <Icon><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /></Icon>;
}

export function DownloadIcon() {
  return <Icon><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" /></Icon>;
}

export function CloseIcon() {
  return <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>;
}

export function CopyIcon() {
  return <Icon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></Icon>;
}

// ── 通用界面图标（C 批：替换原先的文本字形） ──────────────────────

export function PlusIcon() {
  return <Icon><path d="M12 5v14M5 12h14" /></Icon>;
}

export function ChevronDownIcon() {
  return <Icon><path d="m6 10 6 6 6-6" /></Icon>;
}

export function ChevronLeftIcon() {
  return <Icon><path d="m14 6-6 6 6 6" /></Icon>;
}

export function MoreHorizontalIcon() {
  return <Icon><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Icon>;
}

export function SendIcon() {
  return <Icon><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
}

export function StopIcon() {
  return <Icon><rect x="7" y="7" width="10" height="10" rx="1.5" /></Icon>;
}

export function RefreshIcon() {
  return <Icon><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" /></Icon>;
}

export function FolderIcon() {
  return <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>;
}

/** 左侧栏项目节点：带两条内容线的画布，和文件树的文件/文件夹图标区分开。 */
export function ProjectIcon() {
  return <Icon><rect x="3.5" y="4.8" width="17" height="14.4" rx="3" /><path d="M7.5 9.6h9M7.5 14h6" /></Icon>;
}

export function SunIcon() {
  return <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
}

export function MoonIcon() {
  return <Icon><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></Icon>;
}

export function SettingsIcon() {
  return <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.4a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4.4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.2.8z" /></Icon>;
}

export function UploadIcon() {
  return <Icon><path d="M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></Icon>;
}

// ── 账户入口 / 通用设置（账户菜单与外观方块） ─────────────────────

export function UserIcon() {
  return <Icon><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0 1 14 0" /></Icon>;
}

export function SlidersIcon() {
  return <Icon><path d="M4 8h8M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2.2" /><circle cx="8" cy="16" r="2.2" /></Icon>;
}

export function LockIcon() {
  return <Icon><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>;
}

export function LogoutIcon() {
  return <Icon><path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /><path d="m16 8 4 4-4 4M20 12H9" /></Icon>;
}

export function MailIcon() {
  return <Icon><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></Icon>;
}

export function MessageIcon() {
  return <Icon><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.9-.9L3 21l1.8-4.3A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></Icon>;
}

export function SystemThemeIcon() {
  return <Icon><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></Icon>;
}


// 任务清单 / 目标 / 暂停 / 继续：conversation panels（todo dock、goal dock）专用。
export function ChecklistIcon() {
  return <Icon><path d="M4 6h.01M8 6h12M4 12h.01M8 12h12M4 18h.01M8 18h12" /></Icon>;
}

export function GoalIcon() {
  return <Icon><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></Icon>;
}

export function PauseIcon() {
  return <Icon><path d="M9 5v14M15 5v14" /></Icon>;
}

export function PlayIcon() {
  return <Icon><path d="m8 5 11 7-11 7z" /></Icon>;
}
