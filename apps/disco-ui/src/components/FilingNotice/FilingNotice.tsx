export function FilingNotice({ className }: { className?: string }) {
  return (
    <footer className={['disco-filing-notice', className].filter(Boolean).join(' ')}>
      <a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noreferrer noopener"
        aria-label="在工业和信息化部备案管理系统查询京ICP备2026058667号"
      >
        京ICP备2026058667号
      </a>
    </footer>
  );
}
