/**
 * What re-renders (review M2), against the production build, counted with a
 * React DevTools-style commit hook: the components whose props or state
 * changed in each commit.
 * - Play / Pause in Mix re-renders the transport's keys and a few readers of
 *   "playing" (the tab's title), never the whole app (it was about 174
 *   components when the app itself read "playing");
 * - an edit and its save: the edit's own commit, then the save's commits
 *   (Saving…, Saved) re-render only the save state's readers, not the app.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

/** Install the commit counter before the app loads. */
async function countCommits(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakMap<object, { p: unknown; s: unknown }>();
    const w = window as unknown as { __commits: number[]; __count: boolean; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__commits = [];
    w.__count = false;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot(_id: number, root: { current: any }) {
        if (!w.__count) return;
        let rendered = 0;
        const stack = [root.current];
        while (stack.length) {
          const f = stack.pop();
          if (f.child) stack.push(f.child);
          if (f.sibling) stack.push(f.sibling);
          if (typeof f.type !== 'function' && !(f.type && typeof f.type === 'object' && f.type.render)) continue;
          const key = f.alternate && seen.has(f.alternate) ? f.alternate : f;
          const prev = seen.get(key);
          if (prev !== undefined && (prev.p !== f.memoizedProps || prev.s !== f.memoizedState)) rendered++;
          seen.set(key, { p: f.memoizedProps, s: f.memoizedState });
        }
        w.__commits.push(rendered);
      },
    };
  });
}

const commits = (page: Page) => page.evaluate(() => (window as unknown as { __commits: number[] }).__commits);
const reset = (page: Page) => page.evaluate(() => void ((window as unknown as { __commits: number[] }).__commits = []));

test('Play / Pause and a save do not re-render the app', async ({ page }) => {
  await countCommits(page);
  await openFresh(page);
  await jumpIn(page);
  const skip = page.getByRole('button', { name: 'Skip guide' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.getByRole('tab', { name: 'Mix', exact: true }).click();
  await page.waitForTimeout(2500);
  // Start counting: the first commits only record what each component looked like.
  await page.evaluate(() => void ((window as unknown as { __count: boolean }).__count = true));
  await page.waitForTimeout(1500);

  // Play / Pause.
  await reset(page);
  await page.getByRole('button', { name: /^(Pause|Play)$/ }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(false);
  await page.waitForTimeout(600);
  const pause = await commits(page);
  expect(pause.length).toBeGreaterThan(0);
  expect(Math.max(...pause), `Pause: components re-rendered per commit ${pause.join(', ')}`).toBeLessThanOrEqual(40);

  // An edit (its own commit re-renders what shows the tempo), then its save: Saving…, Saved.
  await reset(page);
  await page.evaluate(() => (window as any).__switchboard.session.setBpm((window as any).__switchboard.project().bpm + 1));
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.session.autosaver.status.getState().status), { timeout: 10_000 }).toBe('saved');
  await page.waitForTimeout(800);
  const save = (await commits(page)).sort((a, b) => b - a);
  expect(save.length, 'the edit and the save').toBeGreaterThan(1);
  // Only the edit's own commit is large; the save's commits stay small.
  expect(save.slice(1).every((n) => n <= 20), `components re-rendered per commit ${save.join(', ')}`).toBe(true);
  expect(pageErrors(page)).toEqual([]);
});
