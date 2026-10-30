/**
 * A conversation's last write, the way a phone list says it.
 *
 * A list of ten sessions all stamped "2026-10-29 14:03" is read by nobody; what
 * a person scanning a project wants is "刚刚" or "3 天前". Older rows fall back
 * to a date, because "43 天前" is arithmetic the reader should not have to do.
 */
export function relativeTime(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined || ms <= 0) return "";
  const delta = now - ms;
  // A phone whose clock is behind the desktop's writes a negative delta; it
  // means "just now", not "in the future".
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(ms);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const thisYear = new Date(now).getFullYear();
  return date.getFullYear() === thisYear
    ? `${month} 月 ${day} 日`
    : `${date.getFullYear()} 年 ${month} 月 ${day} 日`;
}
