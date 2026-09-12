import type { ReactElement } from 'react';

/**
 * Degraded-startup visibility (E6: 任何降级都必须在界面上可见，不能只写日志).
 * Consumes the `runtime.issues` list from `/api/local/bootstrap` and renders
 * every action-worthy issue with its remediation entry point.
 */

export interface RuntimeIssue {
  code: string;
  message: string;
  path?: string;
  backupPath?: string;
}

const VISIBLE_CODES = new Set(['parse_error', 'port_in_use']);

export function DegradedBanner({ issues }: { issues: RuntimeIssue[] | undefined }): ReactElement | null {
  const visible = (issues ?? []).filter((i) => VISIBLE_CODES.has(i.code));
  if (visible.length === 0) return null;

  return (
    <div role="alert">
      {visible.map((issue) => (
        <div key={`${issue.code}:${issue.path ?? ''}`} className="banner-danger">
          <strong>降级运行 · </strong>
          {issue.message}
          {issue.code === 'parse_error' && (
            <div style={{ marginTop: 8 }}>
              <a className="btn" href="/local/settings">去修复配置</a>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
