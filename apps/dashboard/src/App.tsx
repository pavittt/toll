import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT, api, GATEWAY, usd, type Payment, type State, type TollEvent } from "./api";
import { FLOW_LIFETIME_MS, Map3D, useLayout, type Flash, type Flow } from "./Map3D";
import { PayPalTopUp } from "./PayPalTopUp";

type AgentLine = { kind: string; text: string; ts: string };

const STATUS_LABEL: Record<Payment["status"], string> = {
  approved: "Paid",
  consumed: "Paid",
  blocked: "Blocked",
  pending_approval: "Needs you",
  refunded: "Refunded",
  expired: "Returned",
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => api<State>("/api/state").then(setState).catch((e: Error) => setErr(e.message)), []);
  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const animate = useCallback((flow?: Omit<Flow, "id" | "born">, flash?: Omit<Flash, "id" | "born">) => {
    const born = Date.now();
    const id = `${born}-${Math.random()}`;
    if (flow) setFlows((f) => [...f, { ...flow, id, born }]);
    if (flash) setFlashes((f) => [...f, { ...flash, id, born }]);
    setTimeout(() => {
      setFlows((f) => f.filter((x) => x.id !== id));
      setFlashes((f) => f.filter((x) => x.id !== id));
    }, FLOW_LIFETIME_MS);
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource(`${GATEWAY}/api/events`);
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as TollEvent;
      if (ev.type === "payment") {
        const p = ev.payment;
        if (p.status === "approved") animate({ from: "agent", to: p.merchantId, color: "#00d18f", label: p.amount }, { node: p.merchantId, color: "#00d18f" });
        if (p.status === "blocked") animate(undefined, { node: "agent", color: "#ff3d5a" });
        if (p.status === "pending_approval") animate(undefined, { node: "agent", color: "#ffc53d" });
      }
      if (ev.type === "topup") animate({ from: "paypal", to: "agent", color: "#2f8cff", label: usd(ev.amountMicros) }, { node: "agent", color: "#2f8cff" });
      if (ev.type === "refund") animate(undefined, { node: "agent", color: "#2f8cff" });
      if (ev.type === "settlement" && ev.totalMicros > 0) {
        state?.merchants.forEach((m) => animate({ from: m.id, to: "paypal", color: "#2f8cff" }));
      }
      refresh();
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wallet = state?.wallets[0];
  const nodes = useLayout(state?.merchants ?? [], wallet?.name ?? "Agent");

  if (err && !state) {
    return (
      <div className="boot">
        <h1>Toll</h1>
        <p>Can't reach the gateway at {GATEWAY}.</p>
        <p className="muted">Run <code>npm run seed</code> then <code>npm run dev</code>.</p>
      </div>
    );
  }
  if (!state) return <div className="boot">Loading...</div>;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo" />
          <div>
            <h1>Toll</h1>
            <p>Pay-per-request for AI agents, settled with PayPal</p>
          </div>
        </div>
        <div className="badges">
          <span className={state.paypalEnabled ? "badge ok" : "badge warn"}>PayPal sandbox {state.paypalEnabled ? "connected" : "not configured"}</span>
          <span className={state.aiEnabled ? "badge ok" : "badge warn"}>AI judge {state.aiEnabled ? "on" : "off"}</span>
        </div>
      </header>

      <main>
        <aside className="col">
          {wallet ? <WalletPanel state={state} onChange={refresh} notify={notify} /> : <p className="muted">No wallet. Run npm run seed.</p>}
        </aside>

        <section className="center">
          <div className="map">
            <Map3D nodes={nodes} flows={flows} flashes={flashes} />
            <Legend />
          </div>
          <AgentConsole />
        </section>

        <aside className="col">
          <Feed payments={state.payments} onChange={refresh} notify={notify} />
          <Merchants state={state} onChange={refresh} notify={notify} />
        </aside>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i style={{ background: "#00d18f" }} /> agent paid a site</span>
      <span><i style={{ background: "#ff3d5a" }} /> payment blocked</span>
      <span><i style={{ background: "#ffc53d" }} /> waiting for you</span>
      <span><i style={{ background: "#2f8cff" }} /> PayPal money in / out</span>
    </div>
  );
}

function WalletPanel({ state, onChange, notify }: { state: State; onChange: () => void; notify: (m: string) => void }) {
  const w = state.wallets[0];
  const [rules, setRules] = useState(w.rulesText);
  const [saving, setSaving] = useState(false);
  const limit = w.policy.dailyLimitUsd * 1e6;
  const pct = Math.min(100, (w.spentTodayMicros / Math.max(limit, 1)) * 100);
  const lastTopup = w.topups.find((t) => t.amount_micros > t.refunded_micros);

  const compile = async () => {
    setSaving(true);
    try {
      await api(`/api/wallets/${w.id}/rules`, { method: "PUT", body: { rulesText: rules } });
      notify("Rules compiled into a strict policy");
      onChange();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    if (!lastTopup) return;
    const available = Math.min(w.balanceMicros, lastTopup.amount_micros - lastTopup.refunded_micros);
    const amountUsd = Math.floor(available / 10_000) / 100;
    if (amountUsd < 0.01) return notify("Nothing to withdraw");
    try {
      await api(`/api/wallets/${w.id}/withdraw`, { body: { captureId: lastTopup.capture_id, amountUsd } });
      notify(`Refunded $${amountUsd.toFixed(2)} to your PayPal account`);
      onChange();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-title">Agent wallet</div>
        <div className="balance">{w.balance}</div>
        <div className="muted small">{w.name}</div>
        <div className="meter">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="muted small">
          {usd(w.spentTodayMicros)} of {usd(limit)} daily limit spent today
        </div>
        <div className="divider" />
        <div className="card-title">Top up with PayPal</div>
        <PayPalTopUp walletId={w.id} onDone={(m) => { notify(m); onChange(); }} />
        {lastTopup && (
          <button className="ghost" onClick={withdraw}>
            Withdraw unused balance to PayPal
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-title">Spending rules</div>
        <p className="muted small">Write them like you'd tell a person. AI turns them into hard limits the agent cannot talk its way around.</p>
        <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={5} />
        <button onClick={compile} disabled={saving}>
          {saving ? "Compiling..." : "Compile rules"}
        </button>
        <div className="policy">
          {w.policyIsDefault && <span className="muted small">Using default limits until you compile.</span>}
          <Chip k="Daily limit" v={`$${w.policy.dailyLimitUsd}`} />
          <Chip k="Per payment" v={`$${w.policy.perPaymentMaxUsd}`} />
          <Chip k="Ask me above" v={w.policy.requireApprovalAboveUsd === null ? "never" : `$${w.policy.requireApprovalAboveUsd}`} />
          {w.policy.allowedCategories.length > 0 && <Chip k="Only" v={w.policy.allowedCategories.join(", ")} />}
          {w.policy.blockedCategories.length > 0 && <Chip k="Never" v={w.policy.blockedCategories.join(", ")} bad />}
          {w.policy.notes && <p className="muted small">{w.policy.notes}</p>}
        </div>
      </div>
    </>
  );
}

function Chip({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <span className={bad ? "pchip bad" : "pchip"}>
      <b>{k}</b> {v}
    </span>
  );
}

function Feed({ payments, onChange, notify }: { payments: Payment[]; onChange: () => void; notify: (m: string) => void }) {
  const decide = async (id: string, approve: boolean) => {
    try {
      await api(`/api/approvals/${id}`, { body: { approve } });
      onChange();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="card feed">
      <div className="card-title">Live payments</div>
      {payments.length === 0 && <p className="muted small">Nothing yet. Run the agent.</p>}
      {payments.slice(0, 30).map((p) => (
        <div key={p.id} className={`pay ${p.status}`}>
          <div className="pay-top">
            <span className="status">{STATUS_LABEL[p.status]}</span>
            <span className="amt">{p.amount}</span>
          </div>
          <div className="pay-merchant">{p.merchantName}</div>
          <div className="pay-res mono">{p.resource.replace(/^https?:\/\//, "")}</div>
          {p.reason && (
            <div className="pay-reason">
              <span className="by">{p.decidedBy === "ai_judge" ? "AI judge" : p.decidedBy === "rules" ? "Hard rule" : p.decidedBy === "owner" ? "You" : p.decidedBy}</span> {p.reason}
            </div>
          )}
          {p.signals.length > 0 && (
            <div className="signals">
              {p.signals.map((s) => (
                <span key={s}>{s.replace(/_/g, " ")}</span>
              ))}
            </div>
          )}
          {p.status === "pending_approval" && (
            <div className="actions">
              <button onClick={() => decide(p.id, true)}>Approve</button>
              <button className="ghost" onClick={() => decide(p.id, false)}>Decline</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Merchants({ state, onChange, notify }: { state: State; onChange: () => void; notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const settle = async () => {
    setBusy(true);
    try {
      const r = await api<{ batchId: string; totalMicros: number; merchants: number }>("/api/settle", { body: {} });
      notify(`PayPal payout ${r.batchId}: ${usd(r.totalMicros)} to ${r.merchants} sites`);
      onChange();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refreshBatch = async (id: string) => {
    try {
      await api(`/api/settlements/${id}/refresh`, { body: {} });
      onChange();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-title">Sites earning from agents</div>
      <table>
        <tbody>
          {state.merchants.map((m) => (
            <tr key={m.id}>
              <td>
                {m.name}
                <div className="muted small">{m.category}</div>
              </td>
              <td className="num">
                {usd(m.pendingMicros)}
                <div className="muted small">{usd(m.settledMicros)} paid out</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={settle} disabled={busy}>
        {busy ? "Sending..." : "Pay out sites with PayPal Payouts"}
      </button>
      {state.settlements.map((s) => (
        <div key={s.batchId} className="batch">
          <span className="mono small">{s.batchId}</span>
          <span className="small">{usd(s.totalMicros)}</span>
          <button className="link" onClick={() => refreshBatch(s.batchId)}>{s.status}</button>
        </div>
      ))}
    </div>
  );
}

function AgentConsole() {
  const [tasks, setTasks] = useState<Array<{ label: string; task: string }>>([]);
  const [task, setTask] = useState("");
  const [lines, setLines] = useState<AgentLine[]>([]);
  const [running, setRunning] = useState(false);
  const [offline, setOffline] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${AGENT}/tasks`)
      .then((r) => r.json())
      .then((d: { tasks: Array<{ label: string; task: string }> }) => {
        setTasks(d.tasks);
        setTask(d.tasks[0]?.task ?? "");
      })
      .catch(() => setOffline(true));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  const run = () => {
    setLines([]);
    setRunning(true);
    const es = new EventSource(`${AGENT}/run?task=${encodeURIComponent(task)}`);
    es.onmessage = (m) => {
      const line = JSON.parse(m.data) as AgentLine;
      if (line.kind === "done") {
        es.close();
        setRunning(false);
        return;
      }
      setLines((l) => [...l, line]);
      if (line.kind === "error") {
        es.close();
        setRunning(false);
      }
    };
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  };

  return (
    <div className="card console">
      <div className="console-head">
        <div className="card-title">Agent</div>
        <div className="tasks">
          {tasks.map((t) => (
            <button key={t.label} className={t.task === task ? "chip active" : "chip"} onClick={() => setTask(t.task)} disabled={running}>
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={run} disabled={running || offline || !task}>
          {running ? "Running..." : "Run agent"}
        </button>
      </div>
      {offline && <p className="muted small">Agent server is not running on {AGENT}.</p>}
      <textarea className="task" value={task} onChange={(e) => setTask(e.target.value)} rows={2} disabled={running} />
      <div className="log mono">
        {lines.map((l, i) => (
          <div key={i} className={`line ${l.kind}`}>
            <span className="kind">{l.kind}</span>
            <span className="text">{l.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
