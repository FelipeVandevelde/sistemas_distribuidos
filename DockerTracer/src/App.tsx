import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BatteryId,
  BehaviorProfileLabel,
  LanguageLabel,
  PlaybackMode,
  TracerStateSnapshot,
} from "./shared/protocol";

const C = { http: "#22d3ee", rest: "#a78bfa", amqp: "#fb923c", sql: "#34d399", sock: "#facc15" };
type N = { id: string; x: number; y: number; w: number; h: number };
const nodes: Record<string, N> = {
  ngx: { id: "ngx", x: 170, y: 300, w: 130, h: 92 },
  api1: { id: "api1", x: 340, y: 200, w: 130, h: 70 },
  api2: { id: "api2", x: 340, y: 420, w: 130, h: 70 },
  mq: { id: "mq", x: 510, y: 130, w: 140, h: 90 },
  rs: { id: "rs", x: 510, y: 470, w: 140, h: 64 },
  pg: { id: "pg", x: 515, y: 580, w: 130, h: 70 },
  w1: { id: "w1", x: 690, y: 200, w: 130, h: 96 },
  w2: { id: "w2", x: 690, y: 380, w: 130, h: 96 },
};
const mid = (n: N, side: "l" | "r" | "t" | "b") =>
  side === "l" ? [n.x, n.y + n.h / 2] : side === "r" ? [n.x + n.w, n.y + n.h / 2] : side === "t" ? [n.x + n.w / 2, n.y] : [n.x + n.w / 2, n.y + n.h];
const links: [string, string, string, string, string][] = [
  ["ngx", "r", "api1", "l", C.http], ["ngx", "r", "api2", "l", C.http],
  ["api1", "r", "mq", "l", C.amqp], ["api2", "r", "mq", "l", C.amqp],
  ["api1", "r", "rs", "l", C.rest], ["api2", "r", "rs", "l", C.rest],
  ["rs", "b", "pg", "t", C.sql], ["mq", "r", "w1", "l", C.amqp], ["mq", "r", "w2", "l", C.amqp],
  ["w1", "b", "rs", "r", C.rest], ["w2", "b", "rs", "r", C.rest],
];
const path = (a: number[], b: number[]) => { const mx = (a[0] + b[0]) / 2; return `M${a[0]},${a[1]} C${mx},${a[1]} ${mx},${b[1]} ${b[0]},${b[1]}`; };

function Led({ c = "#22c55e" }: { c?: string }) { return <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />; }
function Badge({ children, c = "#64748b" }: any) { return <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border" style={{ color: c, borderColor: c + "55", background: c + "14" }}>{children}</span>; }

function Node({ n, title, sub, accent, active, danger, selected, onClick, children }: any) {
  const borderCol = danger ? "#ef4444" : active ? accent : accent + "66";
  const shadowCol = danger ? "0 0 24px #ef444466" : active ? `0 0 24px ${accent}55` : `0 0 18px ${accent}18`;
  const ledCol = danger ? "#ef4444" : active ? "#22d3ee" : "#22c55e";
  return <div
    onClick={onClick}
    title="Clique para inspecionar este componente em tempo real"
    className={`absolute rounded-lg border p-2 shadow-xl transition-all cursor-pointer ${danger ? "bg-[#1c1014]/95" : "bg-[#111722]/95"} ${selected ? "ring-2 ring-cyan-400/70" : "hover:brightness-110"}`}
    style={{ left: n.x, top: n.y, width: n.w, minHeight: n.h, borderColor: borderCol, boxShadow: shadowCol }}
  >
    <div className="flex items-center gap-1.5"><Led c={ledCol} /><span className="text-[11px] font-semibold text-slate-100 truncate">{title}</span></div>
    <div className="text-[9px] font-mono text-slate-500 mb-1">{sub}</div>{children}</div>;
}

const WORLD_W = 1030;
const WORLD_H = 680;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 2.2;

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

async function postApi(endpoint: string, body: Record<string, unknown>): Promise<TracerStateSnapshot | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as TracerStateSnapshot;
  } catch {
    return null;
  }
}

function isLinkActive(a: string, b: string, pdus: TracerStateSnapshot["activePdus"] | undefined) {
  if (!pdus) return null;
  return pdus.find((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a)) ?? null;
}

function NodeInspectorDrawer({
  nodeId,
  snapshot,
  onClose,
}: {
  nodeId: string;
  snapshot: TracerStateSnapshot | null;
  onClose: () => void;
}) {
  const nd = snapshot?.nodes;
  const chaos = snapshot?.chaos;
  if (!nd) return null;

  const titles: Record<string, [string, string, string]> = {
    ngx: ["Nginx Load Balancer", ":8080 · upstream submission_api", C.http],
    api1: ["submission-api-1", ":8081 · ASP.NET Core 9", C.rest],
    api2: ["submission-api-2", ":8080 · ASP.NET Core 9", C.rest],
    mq: ["RabbitMQ 3.13 Broker", ":5672 / :15672 · queue execution.jobs", C.amqp],
    rs: ["result-service", ":8080 · Internal State Authority", C.rest],
    pg: ["PostgreSQL 16", ":5432 · Table public.jobs", C.sql],
    w1: ["worker-1", "BackgroundService · Docker.DotNet", C.amqp],
    w2: ["worker-2", "BackgroundService · Docker.DotNet", C.amqp],
    docker: ["Docker Engine Daemon", "unix:///var/run/docker.sock", C.sock],
  };

  const [title, sub, color] = titles[nodeId] ?? [nodeId, "", "#22d3ee"];

  return (
    <div
      data-canvas-hud="true"
      className="absolute bottom-14 left-3 right-3 rounded-lg border border-slate-700/90 bg-[#0c111a]/95 p-3 text-xs text-slate-200 shadow-2xl backdrop-blur cursor-default z-20"
      style={{ borderTop: `2px solid ${color}` }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Led c={color} />
          <span className="font-semibold text-slate-100">{title}</span>
          <span className="text-[10px] font-mono text-slate-400">{sub}</span>
        </div>
        <button
          onClick={onClose}
          className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-mono cursor-pointer"
        >
          ✕ Fechar Inspeção
        </button>
      </div>

      {(nodeId === "ngx" || nodeId === "api1" || nodeId === "api2") && (
        <div className="grid grid-cols-4 gap-2 text-[10.5px] font-mono">
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">ALGORITMO UPSTREAM</div>
            <div className="text-cyan-300 font-bold mt-0.5">{nd.ngx.algorithm}</div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">CONEXÕES ATIVAS</div>
            <div className="text-slate-200 mt-0.5">
              api-1: <b>{nd.ngx.api1Conn}</b> | api-2: <b>{nd.ngx.api2Conn}</b>
            </div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">TOTAL ROTEADO</div>
            <div className="text-slate-200 mt-0.5">
              api-1: <b>{nd.ngx.totalRoutedApi1}</b> | api-2: <b>{nd.ngx.totalRoutedApi2}</b>
            </div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">BLINDAGEM DE BORDA</div>
            <div className="text-emerald-300 mt-0.5">≤ 64 KB · No Docker Sock</div>
          </div>
        </div>
      )}

      {nodeId === "mq" && (
        <div className="grid grid-cols-4 gap-2 text-[10.5px] font-mono">
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">STATUS DO BROKER</div>
            <div className={chaos?.mq || !nd.mq.healthy ? "text-red-400 font-bold mt-0.5" : "text-emerald-300 font-bold mt-0.5"}>
              {chaos?.mq || !nd.mq.healthy ? "OFFLINE (HTTP 503)" : "ONLINE · HEALTHY"}
            </div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">MENSAGENS NA FILA</div>
            <div className="text-orange-300 mt-0.5">
              Ready: <b>{nd.mq.ready}</b> · Unacked: <b>{nd.mq.unacked}</b>
            </div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">GARANTIA DE PUBLICAÇÃO</div>
            <div className="text-slate-200 mt-0.5">ConfirmSelect + BasicAck</div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px]">QOS DOS WORKERS</div>
            <div className="text-slate-200 mt-0.5">basic.qos(prefetch=1)</div>
          </div>
        </div>
      )}

      {(nodeId === "pg" || nodeId === "rs") && (
        <div>
          <div className="flex items-center gap-3 mb-2 text-[10px] font-mono text-slate-400">
            <span>Total na tabela <b className="text-slate-100">{nd.pg.totalRows}</b></span>
            <span>QUEUED <b className="text-amber-300">{nd.pg.queuedCount}</b></span>
            <span>RUNNING <b className="text-cyan-300">{nd.pg.runningCount}</b></span>
            <span>TERMINAL <b className="text-emerald-300">{nd.pg.terminalCount}</b></span>
            <span className="ml-auto text-violet-300">Última op: {nd.rs.lastOperation}</span>
          </div>
          <div className="max-h-[115px] overflow-y-auto rounded border border-slate-800 bg-black/50">
            <table className="w-full text-left text-[9.5px] font-mono">
              <thead className="bg-slate-900/90 text-slate-400 sticky top-0">
                <tr>
                  <th className="px-2 py-1">job_id</th>
                  <th className="px-2 py-1">lang</th>
                  <th className="px-2 py-1">status</th>
                  <th className="px-2 py-1">worker_id</th>
                  <th className="px-2 py-1">attempt</th>
                  <th className="px-2 py-1">lease_token</th>
                  <th className="px-2 py-1">exit</th>
                </tr>
              </thead>
              <tbody>
                {nd.pg.jobs.slice(0, 8).map((j) => (
                  <tr key={j.id} className="border-t border-slate-800/70 text-slate-300">
                    <td className="px-2 py-1 text-cyan-300">{j.id.slice(0, 8)}…</td>
                    <td className="px-2 py-1">{j.language}</td>
                    <td className="px-2 py-1 font-semibold">{j.status}</td>
                    <td className="px-2 py-1">{j.worker_id ?? "NULL"}</td>
                    <td className="px-2 py-1">{j.attempt_count}</td>
                    <td className="px-2 py-1 text-slate-400">{j.lease_token ? `${j.lease_token.slice(0, 8)}…` : "NULL"}</td>
                    <td className="px-2 py-1">{j.exit_code ?? j.failure_reason ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(nodeId === "w1" || nodeId === "w2") && (() => {
        const w = nd[nodeId];
        return (
          <div className="grid grid-cols-4 gap-2 text-[10.5px] font-mono">
            <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
              <div className="text-slate-500 text-[9px]">ESTADO DO WORKER</div>
              <div className={w.crashed ? "text-red-400 font-bold mt-0.5" : "text-emerald-300 font-bold mt-0.5"}>
                {w.crashed ? "CRASHED (SIGKILL)" : w.busy ? "BUSY · EXECUTANDO" : "IDLE · AGUARDANDO"}
              </div>
            </div>
            <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
              <div className="text-slate-500 text-[9px]">JOB ATUAL & ETAPA</div>
              <div className="text-cyan-300 mt-0.5 truncate">
                {w.currentJobId ? `${w.currentJobId.slice(0, 8)}… (${w.dockerStep})` : "Nenhum job ativo"}
              </div>
            </div>
            <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
              <div className="text-slate-500 text-[9px]">LEASE TOKEN (20s)</div>
              <div className="text-slate-200 mt-0.5 truncate">
                {w.leaseToken ? `${w.leaseToken.slice(0, 12)}… (${w.leaseRemainingSec}s)` : "Sem lease ativo"}
              </div>
            </div>
            <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
              <div className="text-slate-500 text-[9px]">HEARTBEAT & ATTEMPT</div>
              <div className="text-slate-200 mt-0.5">
                HB 5s: <b>{w.heartbeatActive ? "ON" : "OFF"}</b> · Attempt: <b>#{w.attemptCount}</b>
              </div>
            </div>
          </div>
        );
      })()}

      {nodeId === "docker" && (
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px] mb-1">LIMITES CGROUPS</div>
            <div className="text-yellow-200/90">Memory=256MB · Swap=256MB · NanoCpus=1.0 · PidsLimit=64</div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px] mb-1">BLINDAGEM DE KERNEL & REDE</div>
            <div className="text-emerald-300">NetworkMode=none · ReadonlyRootfs · CapDrop=ALL · no-new-privileges</div>
          </div>
          <div className="rounded bg-slate-900/90 p-2 border border-slate-800">
            <div className="text-slate-500 text-[9px] mb-1">AUDITORIA DE LIMPEZA (FINALLY)</div>
            <div className="text-slate-200">
              Containers Órfãos: <b>{nd.docker.orphanContainers}</b> · Volumes tmpfs Órfãos: <b>{nd.docker.orphanVolumes}</b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Canvas({
  burst,
  snapshot,
  onSnapshot,
}: {
  burst: boolean;
  snapshot: TracerStateSnapshot | null;
  onSnapshot: (s: TracerStateSnapshot) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const toggleNodeInspect = (id: string) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
  };

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight - 52;
    const scaleX = (cw - 24) / WORLD_W;
    const scaleY = (ch - 24) / WORLD_H;
    const nextZoom = Math.min(1.15, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)));
    const nextPanX = Math.round((cw - WORLD_W * nextZoom) / 2);
    const nextPanY = Math.round(Math.max(8, (ch - WORLD_H * nextZoom) / 2));
    setZoom(Number(nextZoom.toFixed(2)));
    setPan({ x: nextPanX, y: nextPanY });
  }, []);

  useEffect(() => {
    fitToView();
    window.addEventListener("resize", fitToView);
    return () => window.removeEventListener("resize", fitToView);
  }, [fitToView]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((zoom * factor).toFixed(3))));
    if (nextZoom === zoom) return;

    const scaleRatio = nextZoom / zoom;
    const nextPanX = mouseX - (mouseX - pan.x) * scaleRatio;
    const nextPanY = mouseY - (mouseY - pan.y) * scaleRatio;

    setZoom(nextZoom);
    setPan({ x: nextPanX, y: nextPanY });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("[data-canvas-hud]")) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({ x: dragStartRef.current.panX + dx, y: dragStartRef.current.panY + dy });
  };

  const stopDragging = () => {
    if (isDragging) setIsDragging(false);
  };

  const adjustZoom = (delta: number) => {
    const el = containerRef.current;
    const cx = el ? el.clientWidth / 2 : WORLD_W / 2;
    const cy = el ? (el.clientHeight - 52) / 2 : WORLD_H / 2;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((zoom + delta).toFixed(2))));
    const ratio = nextZoom / zoom;
    setZoom(nextZoom);
    setPan({ x: cx - (cx - pan.x) * ratio, y: cy - (cy - pan.y) * ratio });
  };

  const resetZoom100 = () => {
    setZoom(1);
    setPan({ x: 12, y: 12 });
  };

  const clients = snapshot?.clients?.length
    ? snapshot.clients.map((c) => ({ id: c.id, jobId: c.jobId, n: c.label, l: c.languageLabel, s: c.status }))
    : [{ id: "client-01", jobId: undefined as string | undefined, n: "Client #01", l: "Python", s: "POLLING 750ms" }];

  const clientSpacing = clients.length > 4 ? Math.min(72, Math.floor(540 / clients.length)) : 120;
  const focusedJobId = snapshot?.singleJob?.activeJobId;

  const sc = (s: string) =>
    s === "ABORTED" || s === "503 ERROR" || s === "400 BAD REQ"
      ? "#f87171"
      : s === "200 OK"
        ? "#34d399"
        : s === "SUBMITTING"
          ? "#22d3ee"
          : "#fbbf24";

  const gridStep = Math.max(10, Math.round(18 * zoom));
  const activePdus = snapshot?.activePdus ?? [];
  const nd = snapshot?.nodes;
  const chaos = snapshot?.chaos;
  const mqDown = Boolean(chaos?.mq || nd?.mq.healthy === false);
  const w1Down = Boolean(chaos?.w1 || nd?.w1.crashed || nd?.w1.healthy === false);

  return <div
    ref={containerRef}
    onWheel={handleWheel}
    onMouseDown={handleMouseDown}
    onMouseMove={handleMouseMove}
    onMouseUp={stopDragging}
    onMouseLeave={stopDragging}
    className={`relative flex-1 overflow-hidden select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
    style={{
      backgroundColor: "#0a0e15",
      backgroundImage: "radial-gradient(#1e293b 1px, transparent 1px)",
      backgroundSize: `${gridStep}px ${gridStep}px`,
      backgroundPosition: `${pan.x}px ${pan.y}px`,
    }}
  >
    <div
      className="absolute top-0 left-0 origin-top-left"
      style={{
        width: WORLD_W,
        height: WORLD_H,
        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
      }}
    >
      {[["Clientes Efêmeros", 16], ["Gateway", 180], ["Ingestão", 350], ["Estado & Mensageria", 515], ["Workers", 700], ["Isolamento", 860]].map(([t, x]) =>
        <div key={t as string} className="absolute top-3 text-[9px] uppercase tracking-[0.15em] text-slate-600" style={{ left: x as number }}>{t}</div>)}
      <svg width={WORLD_W} height={WORLD_H} className="absolute inset-0 overflow-visible pointer-events-none">
        {links.map(([a, as, b, bs, c], i) => {
          const activePdu = isLinkActive(a, b, activePdus);
          const forward = !activePdu || activePdu.from === a;
          const pStart = forward ? mid(nodes[a], as as any) : mid(nodes[b], bs as any);
          const pEnd = forward ? mid(nodes[b], bs as any) : mid(nodes[a], as as any);
          const d = path(pStart, pEnd);
          const linkBroken = (mqDown && (a === "mq" || b === "mq")) || (w1Down && (a === "w1" || b === "w1"));
          const showAnim = !linkBroken && (burst || Boolean(activePdu));
          const strokeCol = linkBroken ? "#ef4444" : c;
          return <g key={i}>
            <path d={d} stroke={strokeCol} strokeDasharray={linkBroken ? "3 4" : undefined} strokeOpacity={linkBroken ? ".65" : showAnim ? ".9" : ".28"} strokeWidth={showAnim ? "2.2" : "1.4"} fill="none" style={{ filter: showAnim ? `drop-shadow(0 0 5px ${c})` : undefined }} />
            {showAnim && (
              <g>
                <rect width="10" height="6" rx="1.5" y="-3" fill={c}>
                  <animateMotion dur={burst ? `${1.8 + (i % 3) * 0.4}s` : "1.3s"} repeatCount="indefinite" path={d} />
                </rect>
              </g>
            )}
          </g>;
        })}
        {clients.map((cl, i) => {
          const y = 65 + i * clientSpacing;
          const activePdu = isLinkActive(cl.id, "ngx", activePdus);
          const forward = !activePdu || activePdu.from === cl.id;
          const pStart = forward ? [132, y + 24] : mid(nodes.ngx, "l");
          const pEnd = forward ? mid(nodes.ngx, "l") : [132, y + 24];
          const d = path(pStart, pEnd);
          const showAnim = burst || Boolean(activePdu);
          return <g key={"c" + cl.id}>
            <path d={d} stroke={C.http} strokeOpacity={showAnim ? ".85" : ".3"} strokeDasharray="4 3" strokeWidth={showAnim ? "2" : "1.4"} fill="none" />
            {showAnim && <rect width="9" height="5" rx="1" y="-2.5" fill={C.http}><animateMotion dur="1.2s" repeatCount="indefinite" path={d} /></rect>}
          </g>;
        })}
        {[0, 1].map(i => {
          const wId = i ? "w2" : "w1";
          const activePdu = isLinkActive(wId, "docker", activePdus);
          const d = path(mid(nodes[wId], "r"), [860, 330]);
          const showAnim = burst || Boolean(activePdu);
          return <g key={"s" + i}>
            <path d={d} stroke={C.sock} strokeOpacity={showAnim ? ".9" : ".3"} strokeWidth={showAnim ? "2.2" : "1.5"} fill="none" style={{ filter: showAnim ? `drop-shadow(0 0 5px ${C.sock})` : undefined }} />
            {showAnim && <rect width="10" height="6" rx="1.5" y="-3" fill={C.sock}><animateMotion dur="1.3s" repeatCount="indefinite" path={d} /></rect>}
          </g>;
        })}
      </svg>
      {clients.map((c, i) => {
        const isFocused = !burst && c.jobId && c.jobId === focusedJobId;
        return <div
          key={c.id}
          onClick={() => {
            if (!burst && c.jobId) {
              void postApi("/api/tracer/focus-client", { targetId: c.jobId }).then((s) => s && onSnapshot(s));
            }
          }}
          title="Clique para inspecionar os 22 passos deste cliente"
          className={`absolute w-[118px] rounded-md border bg-[#0f141d] p-1.5 animate-pulse-soft cursor-pointer transition-all ${isFocused ? "border-solid ring-2 ring-cyan-400/50" : "border-dashed"}`}
          style={{ left: 14, top: 65 + i * clientSpacing, borderColor: isFocused ? "#22d3ee" : sc(c.s) + "88", opacity: c.s === "ABORTED" ? .55 : 1, animationDelay: `${i * .2}s` }}
        >
          <div className="text-[10px] font-semibold text-slate-200 flex items-center justify-between"><span>{c.n}</span><span className="text-slate-400 text-[9px]">[{c.l}]</span></div>
          <Badge c={sc(c.s)}>{c.s}</Badge>
        </div>;
      })}
      <Node n={nodes.ngx} title="Nginx LB" sub=":8080" accent={C.http} selected={selectedNodeId === "ngx"} onClick={() => toggleNodeInspect("ngx")} active={burst || activePdus.some(p => p.from === "ngx" || p.to === "ngx")}><Badge c={C.http}>least_conn</Badge><div className="mt-1 grid grid-cols-2 text-[9px] font-mono text-slate-400"><span>api-1: <b className="text-slate-100">{nd?.ngx.api1Conn ?? 1}</b></span><span>api-2: <b className="text-slate-100">{nd?.ngx.api2Conn ?? 0}</b></span></div></Node>
      {(["api1", "api2"] as const).map((k, i) => <Node key={k} n={nodes[k]} title={`submission-api-${i + 1}`} sub={i ? ":8080" : ":8081"} accent={C.rest} selected={selectedNodeId === k} onClick={() => toggleNodeInspect(k)} active={burst || activePdus.some(p => p.from === k || p.to === k)}><Badge c="#34d399">⛨ No Docker Socket</Badge></Node>)}
      <Node n={nodes.mq} title="RabbitMQ Broker" sub=":5672 · execution.jobs" accent={C.amqp} danger={mqDown} selected={selectedNodeId === "mq"} onClick={() => toggleNodeInspect("mq")} active={!mqDown && (burst || activePdus.some(p => p.from === "mq" || p.to === "mq"))}>
        {mqDown ? (
          <div className="mt-0.5"><Badge c="#ef4444">OFFLINE · HTTP 503</Badge><div className="text-[8.5px] font-mono text-red-300/80 mt-1">BROKER_UNAVAILABLE</div></div>
        ) : (
          <>
            <div className="h-2 rounded bg-slate-800 overflow-hidden flex"><div className="bg-orange-400 transition-all" style={{ width: `${nd?.mq.readyPct ?? 0}%` }} /><div className="bg-amber-200/70 transition-all" style={{ width: `${nd?.mq.unackedPct ?? 14}%` }} /></div>
            <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>Ready {nd?.mq.ready ?? 0}</span><span>Unacked {nd?.mq.unacked ?? 0}</span></div>
          </>
        )}
      </Node>
      <Node n={nodes.rs} title="result-service" sub=":8080" accent={C.rest} selected={selectedNodeId === "rs"} onClick={() => toggleNodeInspect("rs")} active={burst || activePdus.some(p => p.from === "rs" || p.to === "rs")}><Badge c={C.sql}>SQL pool {nd?.rs.sqlPoolActive ?? 2}/10</Badge></Node>
      <div
        onClick={() => toggleNodeInspect("pg")}
        title="Clique para inspecionar as linhas reais da tabela jobs no PostgreSQL"
        className={`absolute cursor-pointer transition-all rounded-lg ${selectedNodeId === "pg" ? "ring-2 ring-cyan-400/70" : "hover:brightness-110"}`}
        style={{ left: nodes.pg.x, top: nodes.pg.y }}
      >
        <svg width="130" height="74"><ellipse cx="65" cy="10" rx="60" ry="9" fill="#0f2a22" stroke={C.sql} /><path d="M5 10 V62 A60 9 0 0 0 125 62 V10" fill="#0f1e1a" stroke={C.sql} /><text x="65" y="40" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="600">PostgreSQL 16</text><text x="65" y="54" textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace">:5432 · jobs ({nd?.pg.totalRows ?? 1})</text></svg>
      </div>
      {(["w1", "w2"] as const).map((k, i) => {
        const wState = nd?.[k];
        const isCrashed = k === "w1" ? w1Down : Boolean(wState?.crashed || wState?.healthy === false);
        const remSec = isCrashed ? 0 : (wState?.leaseRemainingSec ?? 0);
        const pct = Math.round((remSec / 20) * 100);
        const hbOn = !isCrashed && (wState?.heartbeatActive ?? false);
        const reclaimed = !isCrashed && ((wState?.attemptCount ?? 0) > 1 || (k === "w2" && w1Down && wState?.busy));
        return <Node key={k} n={nodes[k]} title={`worker-${i + 1}`} sub="prefetch=1" accent={C.amqp} danger={isCrashed} selected={selectedNodeId === k} onClick={() => toggleNodeInspect(k)} active={!isCrashed && (burst || activePdus.some(p => p.from === k || p.to === k))}>
          {isCrashed ? (
            <div className="mt-0.5"><Badge c="#ef4444">CRASHED · SIGKILL</Badge><div className="text-[8.5px] font-mono text-red-300/80 mt-1">Lease 20s expirando...</div></div>
          ) : (
            <>
              <div className="text-[9px] font-mono text-slate-400 flex justify-between"><span>Lease: 20s</span><span>{remSec}s</span></div>
              <div className="h-1 rounded bg-slate-800 mb-1"><div className="h-1 rounded bg-emerald-400 transition-all" style={{ width: `${pct}%` }} /></div>
              <div className="flex items-center justify-between text-[9px] text-slate-400">
                <span className="flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${hbOn ? "bg-pink-400 animate-ping" : "bg-slate-600"}`} />Heartbeat: 5s</span>
                {reclaimed && <span className="text-[8px] font-mono text-cyan-300 bg-cyan-500/15 px-1 rounded">Reclaimed</span>}
              </div>
            </>
          )}
        </Node>;
      })}
      <div
        onClick={() => toggleNodeInspect("docker")}
        title="Clique para inspecionar os sandboxes e parâmetros de isolamento do Docker Engine"
        className={`absolute left-[860px] top-[250px] w-[148px] rounded-lg border bg-[#141208] p-2 cursor-pointer transition-all ${selectedNodeId === "docker" ? "ring-2 ring-cyan-400/70" : "hover:brightness-110"}`}
        style={{ borderColor: C.sock + "77" }}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-100"><Led />Docker Engine</div>
        <div className="text-[9px] font-mono text-slate-500 mb-2">/var/run/docker.sock</div>
        {(nd?.docker.slots ?? [{ slotIndex: 1, active: true, containerName: "dockercode-sandbox", specs: "tmpfs 32MB | 256MB | net:none | ro-rootfs" }, { slotIndex: 2, active: false, containerName: null, specs: "slot livre" }, { slotIndex: 3, active: false, containerName: null, specs: "slot livre" }]).map((sl) => {
          const isOccupied = sl.active;
          return <div key={sl.slotIndex} className={`mb-1 rounded border p-1 text-[8.5px] font-mono transition-all ${!isOccupied ? "border-dashed border-slate-700 text-slate-600" : "border-yellow-500/40 text-yellow-200/80 bg-yellow-500/5"}`}>{!isOccupied ? "slot livre" : (sl.containerName || "dockercode-sandbox")}{isOccupied && <div className="text-slate-500">tmpfs 32MB | 256MB | net:none | ro-rootfs</div>}</div>;
        })}
      </div>
    </div>

    {selectedNodeId && (
      <NodeInspectorDrawer
        nodeId={selectedNodeId}
        snapshot={snapshot}
        onClose={() => setSelectedNodeId(null)}
      />
    )}

    <div data-canvas-hud="true" className="absolute bottom-3 left-3 right-3 flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0e131c]/95 px-3 py-2 text-[10px] text-slate-400 backdrop-blur cursor-default">
      <div className="flex gap-1">
        <button onClick={() => adjustZoom(-0.15)} title="Diminuir Zoom" className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">−</button>
        <button onClick={resetZoom100} title="Resetar para 100%" className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono min-w-[44px] cursor-pointer">{Math.round(zoom * 100)}%</button>
        <button onClick={() => adjustZoom(0.15)} title="Aumentar Zoom" className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">+</button>
        <button onClick={fitToView} title="Centralizar e Ajustar à Tela (Fit to View)" className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 cursor-pointer">⤢</button>
      </div>
      <div className="h-4 w-px bg-slate-700" />
      {Object.entries({ HTTP: C.http, REST: C.rest, AMQP: C.amqp, SQL: C.sql, "Docker Socket": C.sock }).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className="w-4 h-0.5" style={{ background: c }} />{k}</span>)}
      {activePdus[0] && !burst && (
        <span className="ml-2 px-2 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 font-mono text-[9.5px]">
          PDU: {activePdus[0].from} → {activePdus[0].to} [{activePdus[0].label}]
        </span>
      )}
      <div className="ml-auto font-mono">Nodes <b className="text-slate-200">{9 + clients.length}</b> · PDUs em trânsito <b className="text-slate-200">{burst ? 31 : activePdus.length}</b></div></div>
  </div>;
}

function Card({ title, children, right }: any) { return <div className="rounded-lg border border-slate-800 bg-[#0f141d] p-3"><div className="flex items-center justify-between mb-2"><h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">{title}</h3>{right}</div>{children}</div>; }

function Tab1({
  snapshot,
  onSnapshot,
}: {
  snapshot: TracerStateSnapshot | null;
  onSnapshot: (s: TracerStateSnapshot) => void;
}) {
  const [x, setX] = useState<"json" | "pg" | "sb">("json");
  const [stdinDraft, setStdinDraft] = useState("DockerTracer");

  const composer = snapshot?.composer;
  const job = snapshot?.singleJob;
  const lang = composer?.languageLabel ?? job?.languageLabel ?? "Python 3.12";
  const profile = composer?.profileLabel ?? job?.profileLabel ?? "Execução Limpa (Sucesso)";
  const step = snapshot?.currentStepIndex ?? 7;
  const mode = snapshot?.playbackMode ?? "step";
  const playing = snapshot?.playing ?? false;
  const stepLabels = snapshot?.stepLabels ?? [];
  const xray = snapshot?.currentXRay;

  useEffect(() => {
    if (composer?.stdin !== undefined) {
      setStdinDraft(composer.stdin);
    }
  }, [composer?.stdin]);

  const handleSelectLang = async (nextLang: LanguageLabel) => {
    const s = await postApi("/api/tracer/preset", { languageLabel: nextLang });
    if (s) onSnapshot(s);
  };

  const handleSelectProfile = async (nextProfile: BehaviorProfileLabel) => {
    const s = await postApi("/api/tracer/preset", { profileLabel: nextProfile });
    if (s) onSnapshot(s);
  };

  const handleStdinBlur = async () => {
    const s = await postApi("/api/tracer/preset", { stdin: stdinDraft });
    if (s) onSnapshot(s);
  };

  const handleDispatch = async () => {
    const s = await postApi("/api/tracer/single-job", { stdin: stdinDraft });
    if (s) onSnapshot(s);
  };

  const handleStep = async (action: string, stepIndex?: number) => {
    const s = await postApi("/api/tracer/step", { action, stepIndex });
    if (s) onSnapshot(s);
  };

  const handleMode = async (nextMode: PlaybackMode) => {
    const s = await postApi("/api/tracer/mode", { playbackMode: nextMode });
    if (s) onSnapshot(s);
  };

  const handleSpeedIndex = async (idx: number) => {
    const speedMultiplier = SPEED_OPTIONS[idx] ?? 1;
    const s = await postApi("/api/tracer/mode", { speedMultiplier });
    if (s) onSnapshot(s);
  };

  const currentSpeedIdx = Math.max(
    0,
    SPEED_OPTIONS.indexOf(snapshot?.speedMultiplier ?? 1),
  );

  return <div className="space-y-3">
    <Card title="Composer · Requisição Única" right={<span className="text-[10px] font-mono text-slate-500">Job {job?.activeJobId.slice(0, 8)}… → {job?.routedApi === "api2" ? "api-2" : "api-1"}</span>}>
      <div className="grid grid-cols-4 gap-1 p-1 rounded-md bg-slate-900 mb-2">{(["Python 3.12", "Node.js 22", "Java 21", "C++ 14"] as LanguageLabel[]).map(l => <button key={l} onClick={() => void handleSelectLang(l)} className={`text-[11px] py-1 rounded cursor-pointer ${lang === l ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40" : "text-slate-400 hover:text-slate-200"}`}>{l}</button>)}</div>
      <select value={profile} onChange={(e) => void handleSelectProfile(e.target.value as BehaviorProfileLabel)} className="w-full mb-2 rounded bg-slate-900 border border-slate-700 text-xs px-2 py-1.5 text-slate-200">{(["Execução Limpa (Sucesso)", "Erro de Compilação (javac/g++)", "Erro de Runtime", "Estouro de Memória (OOM 256MB)", "Loop Infinito (Timeout 10s)"] as BehaviorProfileLabel[]).map(o => <option key={o} value={o}>{o}</option>)}</select>
      <pre className="text-[10.5px] font-mono bg-black/40 rounded p-2 text-emerald-300/90 mb-2 overflow-x-auto max-h-[88px]">{composer?.sourceCode ?? job?.sourceCode ?? `name = input()\nprint(f"Olá, {name}!")`}</pre>
      <div className="flex gap-2">
        <input value={stdinDraft} onChange={(e) => setStdinDraft(e.target.value)} onBlur={() => void handleStdinBlur()} className="flex-1 rounded bg-slate-900 border border-slate-700 text-xs px-2 font-mono text-slate-200" placeholder="stdin" />
        <button onClick={() => void handleDispatch()} className="rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold px-3 py-1.5 cursor-pointer">▶ Disparar Cliente Único</button>
      </div>
    </Card>
    <Card title="Packet Tracer · Controle" right={<div className="flex text-[10px] rounded bg-slate-900 p-0.5">{([["rt", "Realtime"], ["step", "Passo a Passo"]] as [PlaybackMode, string][]).map(([k, l]) => <button key={k} onClick={() => void handleMode(k)} className={`px-2 py-0.5 rounded cursor-pointer ${mode === k ? "bg-violet-500/25 text-violet-200" : "text-slate-500"}`}>{l}</button>)}</div>}>
      <div className="flex items-center gap-1.5">
        <button onClick={() => void handleStep("RESET")} className="btn cursor-pointer hover:bg-slate-700">⏮ Reset</button>
        <button onClick={() => void handleStep("TOGGLE_PLAY")} className={`btn cursor-pointer ${playing ? "!bg-emerald-500/25 !text-emerald-200" : "hover:bg-slate-700"}`}>{playing ? "⏸ Pause" : "▶ Play"}</button>
        <button onClick={() => void handleStep("NEXT")} className="btn !bg-violet-500/25 !text-violet-100 hover:!bg-violet-500/40 cursor-pointer">⏭ Próximo Passo</button>
        <span className="ml-auto text-[10px] text-slate-500">0.25x</span>
        <input type="range" min="0" max="4" value={currentSpeedIdx} onChange={(e) => void handleSpeedIndex(Number(e.target.value))} className="w-20 accent-violet-400 cursor-pointer" />
        <span className="text-[10px] text-slate-500 font-mono">{snapshot?.speedMultiplier ?? 1}x</span>
      </div>
    </Card>
    <Card title={`Por Baixo dos Panos · ${job?.clientLabel ?? "Client #01"} [${job?.language ?? "python"}]`} right={<Badge c="#22d3ee">passo {step + 1}/22</Badge>}>
      <div className="max-h-[200px] overflow-y-auto pr-1">{stepLabels.map((s, i) => <div key={i} onClick={() => void handleStep("GOTO", i)} className="flex gap-2 cursor-pointer group">
        <div className="flex flex-col items-center"><span className={`w-2.5 h-2.5 rounded-full mt-1 ${i < step ? "bg-emerald-400" : i === step ? "bg-cyan-400 ring-4 ring-cyan-400/20" : "bg-slate-700"}`} />{i < 21 && <span className={`w-px flex-1 ${i < step ? "bg-emerald-500/50" : "bg-slate-800"}`} />}</div>
        <div className={`text-[11px] pb-1.5 font-mono ${i === step ? "text-cyan-200 font-semibold" : i < step ? "text-slate-300" : "text-slate-600 group-hover:text-slate-400"}`}>{String(i + 1).padStart(2, "0")} {s}</div></div>)}</div>
      <div className="mt-2 border-t border-slate-800 pt-2">
        <div className="flex gap-1 mb-2">{([["json", "Payload / Headers"], ["pg", "PostgreSQL Row"], ["sb", "Sandbox & Output"]] as const).map(([k, l]) => <button key={k} onClick={() => setX(k)} className={`text-[10px] px-2 py-1 rounded cursor-pointer ${x === k ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"}`}>{l}</button>)}</div>
        <pre className="text-[10px] font-mono bg-black/40 rounded p-2 text-slate-300 h-[108px] overflow-auto whitespace-pre-wrap">{x === "json" ? (xray?.jsonPayload ?? "") : x === "pg" ? (xray?.pgRowText ?? "") : (xray?.sandboxOutputText ?? "")}</pre>
      </div>
    </Card>
  </div>;
}

function Tab2({
  snapshot,
  onSnapshot,
}: {
  snapshot: TracerStateSnapshot | null;
  onSnapshot: (s: TracerStateSnapshot) => void;
}) {
  const activeBattery = snapshot?.telemetry.activeBattery ?? null;
  const batteryProgressText = snapshot?.telemetry.batteryProgressText ?? null;
  const chaos = snapshot?.chaos ?? { w1: false, mq: false, req: false, lastChaosEvent: null };
  const tel = snapshot?.telemetry;

  const suites: [BatteryId, string, string, string][] = [
    ["smoke", "Smoke Test Completo", "10 casos · 4 linguagens, stdin, compile/runtime error, OOM, truncation, timeout", C.sql],
    ["burst", "Rajada de Concorrência", "Burst c=24 · estressa least_conn e enche a fila", C.http],
    ["drop", "Queda de Requisições", "Abort no polling, payload >64KB (400), network drop", "#f87171"],
    ["hostile", "Workload Hostil", "c=10 · OOM bombs, loops infinitos (kill 10s) + jobs válidos", C.amqp],
  ];

  const lat = tel?.latencies?.length
    ? tel.latencies
    : [
        { label: "HTTP Ingestion", p50: 12, p95: 38 },
        { label: "RabbitMQ Queue Wait", p50: 40, p95: 95 },
        { label: "Docker Sandbox Exec", p50: 310, p95: 980 },
        { label: "Total Turnaround", p50: 520, p95: 1250 },
      ];

  const handleToggleBattery = async (suiteId: BatteryId) => {
    const s = await postApi("/api/tracer/suite", { suiteId });
    if (s) onSnapshot(s);
  };

  const handleToggleChaos = async (key: "w1" | "mq" | "req") => {
    const s = await postApi("/api/tracer/chaos", { key });
    if (s) onSnapshot(s);
  };

  const orphanContainers = tel?.orphanContainers ?? 0;
  const orphanVolumes = tel?.orphanVolumes ?? 0;
  const noOrphans = orphanContainers === 0 && orphanVolumes === 0;

  return <div className="space-y-3">
    <Card
      title="Baterias Automatizadas"
      right={batteryProgressText && <span className="text-[10px] font-mono text-cyan-300 truncate max-w-[230px]" title={batteryProgressText}>{batteryProgressText}</span>}
    >
      <div className="grid grid-cols-2 gap-2">{suites.map(([id, t, d, c]) => {
        const isRunning = activeBattery === id;
        return <div key={id} className={`rounded-md border p-2 flex flex-col transition-all ${isRunning ? "border-cyan-500/60 bg-cyan-950/20" : "border-slate-800 bg-slate-900/50"}`}>
          <div className="text-xs font-semibold text-slate-100" style={{ borderLeft: `2px solid ${c}`, paddingLeft: 6 }}>{t}</div>
          <div className="text-[10px] text-slate-500 my-1.5 flex-1">{d}</div>
          <button onClick={() => void handleToggleBattery(id)} className="text-[10px] font-semibold rounded py-1 border cursor-pointer hover:brightness-110 transition-all" style={{ color: c, borderColor: c + "66", background: isRunning ? c + "2e" : c + "14" }}>{isRunning ? "■ Parar Bateria" : "▶ Executar Bateria"}</button>
        </div>;
      })}</div>
    </Card>
    <Card title="Caos & Injeção de Falhas">
      {([
        ["w1", "Derrubar Worker-1 em Execução", "docker stop -t 0 worker-1 · Lease 20s expira → worker-2 reclama"],
        ["mq", "Indisponibilizar RabbitMQ", "docker stop rabbitmq · Job → BROKER_UNAVAILABLE · HTTP 503"],
        ["req", "Cancelar / Derrubar Requisição Ativa", "AbortController.abort() · Mata cliente em voo"],
      ] as ["w1" | "mq" | "req", string, string][]).map(([k, t, d]) =>
        <div key={k} className="flex items-center gap-3 py-1.5 border-b border-slate-800/70 last:border-0">
          <div className="flex-1"><div className="text-xs text-slate-200">{t}</div><div className="text-[10px] text-slate-500 font-mono">{d}</div></div>
          <button onClick={() => void handleToggleChaos(k)} className={`w-9 h-5 rounded-full relative transition cursor-pointer ${chaos[k] ? "bg-red-500" : "bg-slate-700"}`}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${chaos[k] ? "left-4.5" : "left-0.5"}`} /></button>
        </div>)}
      {chaos.lastChaosEvent && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 text-[10px] font-mono px-2 py-1">
          ⚡ {chaos.lastChaosEvent}
        </div>
      )}
    </Card>
    <Card title="Telemetria ao Vivo">
      <div className="grid grid-cols-4 gap-2 mb-3">{[
        ["Clientes", tel?.activeClients ?? 1, "#22d3ee"],
        ["Jobs/s", tel?.jobsPerSec ?? "0.0", "#a78bfa"],
        ["Sucesso", tel?.successRate ?? "100%", "#34d399"],
        ["Erros Infra", tel?.infraErrors ?? 0, "#f87171"],
      ].map(([l, v, c]) =>
        <div key={l as string} className="rounded bg-slate-900 p-2"><div className="text-[9px] uppercase text-slate-500">{l}</div><div className="text-lg font-bold font-mono" style={{ color: c as string }}>{v}</div></div>)}</div>
      {lat.map(({ label, p50, p95 }) => {
        const p95Width = Math.min(100, Math.max(2, p95 / 25));
        const p50Width = Math.min(100, Math.max(1, p50 / 25));
        return <div key={label} className="mb-1.5">
          <div className="flex justify-between text-[10px] text-slate-400"><span>{label}</span><span className="font-mono">P50 {p50}ms · P95 {p95}ms</span></div>
          <div className="relative h-1.5 rounded bg-slate-800"><div className="absolute h-1.5 rounded bg-violet-400/40 transition-all" style={{ width: `${p95Width}%` }} /><div className="absolute h-1.5 rounded bg-cyan-400 transition-all" style={{ width: `${p50Width}%` }} /></div>
        </div>;
      })}
      <div className={`mt-2 rounded border text-[10.5px] font-mono px-2 py-1.5 ${noOrphans ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
        {noOrphans ? "✓" : "⚠"} Containers Órfãos: {orphanContainers} | Volumes tmpfs Órfãos: {orphanVolumes}
      </div>
    </Card>
  </div>;
}

export default function App() {
  const [tab, setTab] = useState(1);
  const [t, setT] = useState(0);
  const [snapshot, setSnapshot] = useState<TracerStateSnapshot | null>(null);

  useEffect(() => {
    const i = setInterval(() => setT(x => x + 1), 1000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    fetch("/api/tracer/state")
      .then(r => r.json())
      .then((s: TracerStateSnapshot) => setSnapshot(s))
      .catch(() => {});

    const es = new EventSource("/api/tracer/stream");
    es.onmessage = (ev) => {
      try {
        const next = JSON.parse(ev.data) as TracerStateSnapshot;
        setSnapshot(next);
      } catch {
        // ignore parse errors
      }
    };
    return () => es.close();
  }, []);

  const clock = new Date(t * 1000).toISOString().substr(11, 8);
  const isBatteryActive = Boolean(snapshot?.telemetry.activeBattery);
  const queuedCount = snapshot?.nodes.mq.ready ?? 0;
  const isLive = snapshot?.liveBridgeAvailable ?? false;
  const orphans = (snapshot?.nodes.docker.orphanContainers ?? 0) + (snapshot?.nodes.docker.orphanVolumes ?? 0);

  return <div className="h-screen w-screen flex flex-col bg-[#080b11] text-slate-200 font-sans overflow-hidden">
    <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-slate-800 bg-[#0c1018]">
      <div className="flex items-center gap-2"><div className="w-6 h-6 rounded bg-gradient-to-br from-cyan-400 to-violet-500" /><b className="text-sm">DockerTracer</b><span className="text-[11px] text-slate-500 hidden xl:inline">Distributed Sandbox Network Simulator</span></div>
      <div className="flex gap-2 ml-6">{[
        [isLive ? "LIVE · DockerCode :8080" : "SIMULATED MODE", isLive ? "#22d3ee" : "#fbbf24"],
        [snapshot?.nodes.docker.healthy !== false ? "Docker Engine: Online" : "Docker Engine: Offline", snapshot?.nodes.docker.healthy !== false ? "#34d399" : "#f87171"],
        [`RabbitMQ: ${queuedCount} Queued`, queuedCount > 0 ? "#fbbf24" : "#34d399"],
        [snapshot?.nodes.pg.healthy !== false ? `Postgres: Healthy (${snapshot?.nodes.pg.totalRows ?? 0} jobs)` : "Postgres: Offline", snapshot?.nodes.pg.healthy !== false ? "#34d399" : "#f87171"],
        [`Orphan Containers: ${orphans}`, orphans === 0 ? "#34d399" : "#f87171"],
      ].map(([l, c]) =>
        <span key={l} className="flex items-center gap-1.5 text-[11px] rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5"><Led c={c} />{l}</span>)}</div>
      <div className="ml-auto font-mono text-xs text-slate-400">SIM <span className="text-cyan-300">T+{clock}</span></div></header>
    <div className="flex flex-1 min-h-0">
      <div className="w-[62%] flex"><Canvas burst={isBatteryActive} snapshot={snapshot} onSnapshot={setSnapshot} /></div>
      <aside className="w-[38%] border-l border-slate-800 bg-[#0b0f16] flex flex-col min-h-0">
        <div className="grid grid-cols-2 border-b border-slate-800">{["1. Cliente Único (Raio-X)", "2. Baterias & Carga (Automação/Caos)"].map((l, i) =>
          <button key={l} onClick={() => setTab(i + 1)} className={`py-3 text-xs font-semibold border-b-2 cursor-pointer ${tab === i + 1 ? "border-cyan-400 text-cyan-200 bg-cyan-500/5" : "border-transparent text-slate-500 hover:text-slate-300"}`}>{l}</button>)}</div>
        <div className="flex-1 overflow-y-auto p-3">{tab === 1 ? <Tab1 snapshot={snapshot} onSnapshot={setSnapshot} /> : <Tab2 snapshot={snapshot} onSnapshot={setSnapshot} />}</div></aside></div></div>;
}
