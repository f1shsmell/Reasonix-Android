/**
 * The chat screen.
 *
 * It owns three things a row cannot: the scroll position, the composer, and the
 * send state. The transcript itself is a pure fold, so everything below this
 * file is testable without a browser.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import { cancel, submit } from "../net/submit";
import type { SendState } from "../net/submit";
import { emptyTranscript, reduce } from "./transcript";
import type { Transcript } from "./transcript";
import {
  ApprovalCard,
  AskCard,
  AssistantBubble,
  NoticeCard,
  ToolCard,
  UserBubble,
} from "./Rows";
import type { PromptHandlers } from "./Rows";

export interface ChatScreenProps {
  connection: Connection;
  snapshot: ConnectionSnapshot;
  runtimeId: string;
  onBack: () => void;
}

function useTranscript(snapshot: ConnectionSnapshot): Transcript {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const lastEvent = snapshot.lastEvent;

  useEffect(() => {
    if (!lastEvent) return;
    setTranscript((current) => reduce(current, lastEvent));
  }, [lastEvent]);

  return transcript;
}

export function ChatScreen({ connection, snapshot, runtimeId, onBack }: ChatScreenProps) {
  const runtime = snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
  const transcript = useTranscript(snapshot);
  const [draft, setDraft] = useState("");
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastRetry = useRef<string>("");

  // Attaching is the screen's job, not the caller's: a screen that is mounted
  // and not subscribed shows a still frame that looks like a hang.
  useEffect(() => {
    connection.attach(runtimeId);
    return () => connection.detach();
  }, [connection, runtimeId]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Follow the newest row only while the person is already at the bottom.
  // Yanking the view down while they read back is the single worst thing a
  // streaming transcript can do.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom(false);
  }, [transcript.rows, atBottom, scrollToBottom]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAtBottom(gap < 48);
  }, []);

  const grow = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);

  const doSend = useCallback(
    async (text: string) => {
      if (!runtime) return;
      setSend({ kind: "sending" });
      const result = await submit(runtime.base, text);
      if (result.ok) {
        setSend({ kind: "sent" });
        setDraft("");
        lastRetry.current = "";
        // The turn itself will report through the stream; the composer clears
        // now so the next thought can be typed while the answer arrives.
        requestAnimationFrame(() => {
          if (inputRef.current) inputRef.current.style.height = "auto";
        });
        scrollToBottom(true);
        return;
      }
      setSend({
        kind: "failed",
        detail: result.code ?? "unknown",
        retryable: result.retryable === true,
      });
      lastRetry.current = text;
    },
    [runtime, scrollToBottom],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter breaks the line. On a phone keyboard Enter is
      // the send key people expect; the desktop convention is the fallback.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (send.kind !== "sending" && draft.trim()) void doSend(draft);
      }
    },
    [draft, doSend, send.kind],
  );

  const handlers = useMemo<PromptHandlers>(
    () => ({
      onAnswer: (askId, labels) => {
        if (!runtime) return;
        void fetch(`${runtime.base}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ id: askId, answers: labels }),
        });
      },
      onApprove: (approvalId, allow, remember) => {
        if (!runtime) return;
        void fetch(`${runtime.base}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ id: approvalId, allow, remember }),
        });
      },
    }),
    [runtime],
  );

  if (!runtime) {
    return (
      <div className="chat">
        <div className="chat-head">
          <button type="button" className="iconbtn" onClick={onBack} aria-label="返回">
            ←
          </button>
          <div className="title">
            <strong>会话不存在</strong>
          </div>
        </div>
        <div className="centered">
          <div>
            <strong>这个会话已经关掉了</strong>
            它可能被桌面端关闭，或者连接换了。
          </div>
        </div>
      </div>
    );
  }

  const streaming = transcript.running;

  return (
    <div className="chat">
      <div className="chat-head">
        <button type="button" className="iconbtn" onClick={onBack} aria-label="返回">
          ←
        </button>
        <div className="title">
          <strong>{runtime.name}</strong>
          <span>
            {runtime.readOnly ? "只读 · " : ""}
            {transcript.modelRef ?? runtime.root}
          </span>
        </div>
        <span className={`dot ${snapshot.stream.kind === "open" ? "ok" : "warn"}`} />
      </div>

      <div className="transcript" ref={listRef} onScroll={onScroll}>
        {transcript.rows.length === 0 ? (
          <div className="centered">
            <div>
              <strong>还没有消息</strong>
              问点什么，或者去桌面端看看这个会话。
            </div>
          </div>
        ) : (
          transcript.rows.map((row) => {
            switch (row.kind) {
              case "user":
                return <UserBubble key={row.id} row={row} />;
              case "assistant":
                return <AssistantBubble key={row.id} row={row} />;
              case "tool":
                return <ToolCard key={row.id} row={row} />;
              case "notice":
                return <NoticeCard key={row.id} row={row} />;
              case "ask":
                return <AskCard key={row.id} row={row} handlers={handlers} />;
              case "approval":
                return <ApprovalCard key={row.id} row={row} handlers={handlers} />;
            }
          })
        )}
        {transcript.ended && !transcript.ended.cancelled && transcript.ended.error ? (
          <div className="notice error">
            <div>这一轮失败了</div>
            <details>
              <summary>详情</summary>
              <div>{transcript.ended.error}</div>
            </details>
          </div>
        ) : null}
      </div>

      {send.kind === "failed" ? (
        <div className="sendfail">
          <span>没发出去：{send.detail}</span>
          {send.retryable && lastRetry.current ? (
            <button type="button" onClick={() => void doSend(lastRetry.current)}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="composer">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={runtime.readOnly ? "这个会话是只读的" : "说点什么"}
          disabled={runtime.readOnly === true}
          rows={1}
          onChange={(event) => {
            setDraft(event.target.value);
            grow();
          }}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button
            type="button"
            className="send stop"
            aria-label="停止"
            onClick={() => void cancel(runtime.base)}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="send"
            aria-label="发送"
            disabled={!draft.trim() || send.kind === "sending"}
            onClick={() => void doSend(draft)}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
