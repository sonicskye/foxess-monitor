/**
 * The diagnostics panel, opened with the `d` key.
 *
 * Exists so the machine can be diagnosed from the kiosk screen itself — noticing at a glance that
 * the quota is nearly spent, or that a job has been failing since breakfast, without finding a
 * second computer and an SSH session. Read-only, and the server redacts it exactly like the logs.
 */

import { useEffect, useState } from 'preact/hooks';
import { fetchDiagnostics, type Diagnostics as Data } from '../api.ts';
import { clockTimeWithSeconds, relativeAge } from '../format.ts';

export function Diagnostics({ timeZone, onClose }: { timeZone: string; onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      fetchDiagnostics().then(
        (d) => alive && setData(d),
        (err: unknown) => alive && setError(String(err)),
      );
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const quotaPct = data ? Math.round((data.budget.used / data.budget.cap) * 100) : 0;

  return (
    <div class="diag-backdrop" onClick={onClose}>
      <div class="diag" onClick={(e) => e.stopPropagation()}>
        <div class="diag-head">
          <h2>Diagnostics</h2>
          <button class="diag-close" onClick={onClose} aria-label="Close diagnostics">
            esc
          </button>
        </div>

        {error && <p class="diag-error">{error}</p>}
        {!data && !error && <p class="diag-muted">Loading…</p>}

        {data && (
          <>
            <section>
              <h3>API budget</h3>
              <div class="diag-quota">
                <div class="diag-quota-track">
                  <div
                    class="diag-quota-fill"
                    style={{
                      width: `${Math.min(100, quotaPct)}%`,
                      background: quotaPct > 90 ? 'var(--critical)' : quotaPct > 75 ? 'var(--warning)' : 'var(--good)',
                    }}
                  />
                </div>
                <span>
                  {data.budget.used} / {data.budget.cap} used today ({quotaPct}%)
                </span>
              </div>
              <dl class="diag-grid">
                <dt>FoxESS reports</dt>
                <dd>
                  {data.budget.quotaRemaining ?? '—'} of {data.budget.quotaTotal ?? '—'} remaining
                </dd>
                <dt>Projected</dt>
                <dd>
                  {data.projection.total}/day at the configured intervals
                </dd>
                <dt>Rate limited</dt>
                <dd>
                  {data.budget.backoffUntil
                    ? `backing off until ${clockTimeWithSeconds(data.budget.backoffUntil, timeZone)}`
                    : 'no'}
                </dd>
                <dt>Day</dt>
                <dd>{data.budget.day}</dd>
              </dl>
            </section>

            {/* Failing jobs first: the error used to be a column in a table nobody scrolled to. */}
            {Object.entries(data.jobs).some(([, j]) => j.lastError) && (
              <section>
                <h3>Failing jobs</h3>
                <ul class="diag-failures">
                  {Object.entries(data.jobs)
                    .filter(([, j]) => j.lastError)
                    .map(([name, j]) => (
                      <li key={name}>
                        <strong>{name}</strong> — {j.lastError}
                        <span class="diag-muted">
                          {' '}
                          ({j.failures} failure{j.failures === 1 ? '' : 's'}
                          {j.nextRunAt ? `, retrying ${clockTimeWithSeconds(j.nextRunAt, timeZone)}` : ''})
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
            )}

            <section>
              <h3>Jobs</h3>
              <table class="diag-table">
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Last success</th>
                    <th scope="col">Next</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Fails</th>
                    <th scope="col">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.jobs).map(([name, job]) => (
                    <tr key={name} class={job.lastError ? 'is-bad' : undefined}>
                      <td>{name}</td>
                      <td>{job.lastSuccessAt ? clockTimeWithSeconds(job.lastSuccessAt, timeZone) : '—'}</td>
                      <td>{job.nextRunAt ? clockTimeWithSeconds(job.nextRunAt, timeZone) : '—'}</td>
                      <td>{job.runs}</td>
                      <td>{job.failures}</td>
                      <td class="diag-err">{job.lastError ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3>Recent API calls</h3>
              {data.recentCalls.length === 0 ? (
                <p class="diag-muted">
                  None recorded{data.config['mock'] ? ' — mock mode makes no API calls' : ''}.
                </p>
              ) : (
                <table class="diag-table">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Path</th>
                      <th scope="col">ms</th>
                      <th scope="col">errno</th>
                      <th scope="col">Try</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.recentCalls].reverse().slice(0, 20).map((call, i) => (
                      <tr key={i} class={call.errno !== 0 ? 'is-bad' : undefined}>
                        <td>{clockTimeWithSeconds(call.ts, timeZone)}</td>
                        <td class="diag-path">{call.path}</td>
                        <td>{call.ms}</td>
                        <td>{call.errno ?? '—'}</td>
                        <td>{call.attempt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3>Process</h3>
              <dl class="diag-grid">
                <dt>Started</dt>
                <dd>
                  {clockTimeWithSeconds(data.startedAt, timeZone)} ({relativeAge(Date.parse(data.startedAt))})
                </dd>
                <dt>Polling</dt>
                <dd>{data.idle ? 'idle — slowed, no viewers' : 'active'}</dd>
                <dt>Config</dt>
                <dd class="diag-config">{JSON.stringify(data.config)}</dd>
              </dl>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
