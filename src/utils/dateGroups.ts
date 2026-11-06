export function localDayKey(ms: number | null): string {
  if (ms == null) return "__unknown__";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDayGroupLabel(dayKey: string): string {
  if (dayKey === "__unknown__") return "Unknown date";
  const today = localDayKey(Date.now());
  const yesterday = localDayKey(Date.now() - 86_400_000);
  if (dayKey === today) return "Today";
  if (dayKey === yesterday) return "Yesterday";
  const [y, mo, day] = dayKey.split("-").map(Number);
  const date = new Date(y, mo - 1, day);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: y === new Date().getFullYear() ? undefined : "numeric",
  });
}

export type Group<T> = {
  key: string;
  label: string;
  items: T[];
  start: number;
};

export function groupConsecutive<T>(
  items: T[],
  getKey: (item: T) => string,
  getLabel: (key: string) => string,
): Group<T>[] {
  const groups: Group<T>[] = [];
  items.forEach((item, i) => {
    const key = getKey(item);
    const prev = groups[groups.length - 1];
    if (prev && prev.key === key) {
      prev.items.push(item);
    } else {
      groups.push({ key, label: getLabel(key), items: [item], start: i });
    }
  });
  return groups;
}

export function groupByLocalDay<T>(items: T[], getCapturedAtMs: (item: T) => number | null): Group<T>[] {
  return groupConsecutive(items, (i) => localDayKey(getCapturedAtMs(i)), formatDayGroupLabel);
}
