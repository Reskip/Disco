import { useEffect, useMemo, useState } from 'react';
import { HOME_GREETINGS, type HomeGreeting } from './homeGreetings';

export function getLocalCalendarDay(date = new Date()): number {
  // UTC encodes the local calendar date here, so DST cannot shorten a day index.
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function selectDailyHomeGreeting(userId: string, day: number): HomeGreeting {
  let seed = 2166136261;
  for (const character of userId) {
    seed = Math.imul(seed ^ (character.codePointAt(0) ?? 0), 16777619) >>> 0;
  }

  // A stable per-user shuffle keeps refreshes/devices consistent without storing
  // profile data. Walk the shuffled deck daily: no repeats until all 300 are used.
  const order = HOME_GREETINGS.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let random = Math.imul(seed ^ (seed >>> 15), seed | 1);
    random ^= random + Math.imul(random ^ (random >>> 7), random | 61);
    const swap = Math.floor((((random ^ (random >>> 14)) >>> 0) / 4294967296) * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  const position = ((day % order.length) + order.length) % order.length;
  return HOME_GREETINGS[order[position]];
}

export function formatHomeGreeting(greeting: HomeGreeting, name: string): HomeGreeting {
  // A replacement callback preserves literal "$&" and similar text in user names.
  return [
    greeting[0].replaceAll('{name}', () => name),
    greeting[1].replaceAll('{name}', () => name),
  ];
}

export function useDailyHomeGreeting(
  userId: string | null | undefined,
  name: string
): HomeGreeting {
  const [day, setDay] = useState(getLocalCalendarDay);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const now = new Date();
      setDay(getLocalCalendarDay(now));
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refresh, Math.max(1, midnight.getTime() - now.getTime()));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const greeting = useMemo(() => selectDailyHomeGreeting(userId ?? '', day), [userId, day]);
  return formatHomeGreeting(greeting, name);
}
