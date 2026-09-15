/**
 * Whether the reader is allowed to wake the phone, as a screen reads it.
 *
 * The preference itself is one key in `smsAutoReadStore`; this is the two lines
 * of plumbing a switch needs — the stored answer, and a setter that writes it
 * and puts the schedule where it now says. Registering happens here rather than
 * waiting for the next evaluation, because a switch that takes effect the next
 * time the app is opened is a switch people flip twice.
 *
 * Turning it off never turns the reader off: the app still reads the inbox on
 * the way in (`smsAutoRead.ts`, trigger 2), and the account stays armed. The
 * only thing that stops is the hourly wake-up.
 */

import { useCallback, useEffect, useState } from 'react';

import { backgroundCheckWanted, saveBackgroundCheckWanted } from './smsAutoReadStore';
import { syncAutoReadSchedule } from './smsAutoReadTask';

export function useBackgroundCheck(): {
  wanted: boolean;
  setWanted: (wanted: boolean) => void;
} {
  // Optimistic: the stored value lands a tick later, and a switch that starts
  // off and flicks on by itself reads as the app changing its own mind.
  const [wanted, setLocal] = useState(true);

  useEffect(() => {
    let alive = true;
    void backgroundCheckWanted().then((stored) => {
      if (alive) setLocal(stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setWanted = useCallback((next: boolean): void => {
    setLocal(next);
    void saveBackgroundCheckWanted(next).then(() => syncAutoReadSchedule(next));
  }, []);

  return { wanted, setWanted };
}
