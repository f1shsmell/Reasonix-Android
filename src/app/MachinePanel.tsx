/**
 * What the desktop machine is doing, read-only.
 *
 * Everything here is a decision the desktop owns: spend, window, tool
 * boundary, version. A phone that could flip a machine-wide switch would be
 * changing rules for every session on that computer; a phone that can explain
 * them answers the question the person actually has while away from the desk.
 */

import { useCallback, useEffect, useState } from "react";
import { compactCount, loadMachine } from "../net/machine";
import type { MachineSnapshot } from "../net/machine";

const MODE_LABEL: Record<string, string> = {
  ask: "逐次询问",
  allow: "默认允许",
  deny: "默认拒绝",
};

function percent(used: number, window: number): number {
  if (window <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / window) * 100)));
}

export function MachinePanel({ base }: { base?: string | undefined }) {
  const [snapshot, setSnapshot] = useState<MachineSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    void loadMachine(base ?? "").then((next) => {
      setSnapshot(next);
      setLoading(false);
    });
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && snapshot === null) {
    return <p className="group-note">正在读取这台机器的状态…</p>;
  }

  const empty =
    snapshot === null ||
    (snapshot.usage === null &&
      snapshot.context === null &&
      snapshot.tools === null &&
      snapshot.boundary === null &&
      snapshot.version === null);

  if (empty) {
    return (
      <p className="group-note">连上电脑后，这里显示它的用量、工具边界与版本。</p>
    );
  }

  const { usage, context, tools, boundary, version } = snapshot;
  const used = context ? percent(context.used, context.window) : 0;
  const enabled = tools ? tools.total - tools.disabled.length : 0;

  return (
    <>
      <p className="group-label">这台电脑</p>
      <section className="group">
        {usage ? (
          <div className="setting">
            <span className="setting-main">
              <span className="setting-title">最近 30 天</span>
              <span className="setting-sub">
                {usage.requests} 次请求 · {usage.turns} 轮
                {usage.cost.length > 0 ? ` · ${usage.cost.join(" / ")}` : ""}
                {usage.topModel ? ` · ${usage.topModel}` : ""}
              </span>
            </span>
            <span className="setting-value">{compactCount(usage.tokens)} tokens</span>
          </div>
        ) : null}

        {context ? (
          <div className="setting">
            <span className="setting-main">
              <span className="setting-title">上下文</span>
              <span className="setting-sub">
                {compactCount(context.used)} / {compactCount(context.window)}
                {context.compactAt > 0
                  ? ` · 到 ${compactCount(context.compactAt)} 自动压缩`
                  : " · 不自动压缩"}
                {context.boundary ? ` · ${context.boundary}` : ""}
              </span>
              <span className="machine-bar" aria-hidden="true">
                <i style={{ width: `${used}%` }} />
              </span>
            </span>
            <span className="setting-value">{used}%</span>
          </div>
        ) : null}

        {tools ? (
          <div className="setting">
            <span className="setting-main">
              <span className="setting-title">工具</span>
              <span className="setting-sub">
                {tools.disabled.length > 0
                  ? `停用：${tools.disabled.slice(0, 6).join("、")}${tools.disabled.length > 6 ? " 等" : ""}`
                  : "全部启用"}
              </span>
            </span>
            <span className="setting-value">
              {enabled} / {tools.total}
            </span>
          </div>
        ) : null}

        {boundary ? (
          <div className="setting">
            <span className="setting-main">
              <span className="setting-title">工具权限</span>
              <span className="setting-sub">
                允许 {boundary.allow} · 询问 {boundary.ask} · 拒绝 {boundary.deny}
              </span>
            </span>
            <span className="setting-value">{MODE_LABEL[boundary.mode] ?? boundary.mode}</span>
          </div>
        ) : null}

        {version ? (
          <div className="setting">
            <span className="setting-main">
              <span className="setting-title">桌面端版本</span>
              <span className="setting-sub">{version.current}</span>
            </span>
            <span className="setting-value">
              {version.newer ? `可更新 ${version.latest}` : "已是最新"}
            </span>
          </div>
        ) : null}
      </section>
      <p className="group-note">只读；修改仍在电脑上完成。</p>
    </>
  );
}
