import { Canvas, useFrame } from "@react-three/fiber";
import { Html, Line, OrbitControls, Stars } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { Merchant } from "./api";

export type Flow = {
  id: string;
  from: string; // node id
  to: string;
  color: string;
  label?: string;
  born: number;
};

export type Flash = { id: string; node: string; color: string; born: number };

type Node = { id: string; label: string; sub?: string; pos: THREE.Vector3; color: string; size: number };

const FLOW_MS = 1600;
const FLASH_MS = 1400;

export function useLayout(merchants: Merchant[], walletName: string) {
  return useMemo(() => {
    const nodes: Record<string, Node> = {
      agent: { id: "agent", label: walletName || "Agent", sub: "AI agent wallet", pos: new THREE.Vector3(0, 0, 0), color: "#7c5cff", size: 0.55 },
      paypal: { id: "paypal", label: "PayPal", sub: "top-ups & payouts", pos: new THREE.Vector3(0, 2.4, -2.2), color: "#2f8cff", size: 0.42 },
    };
    const r = 3.6;
    merchants.forEach((m, i) => {
      const a = (i / Math.max(merchants.length, 1)) * Math.PI * 2 + Math.PI / 4;
      nodes[m.id] = {
        id: m.id,
        label: m.name,
        sub: m.category,
        pos: new THREE.Vector3(Math.cos(a) * r, -0.6 + Math.sin(a * 2) * 0.4, Math.sin(a) * r),
        color: m.category === "shopping" ? "#ff8a3d" : "#00d18f",
        size: 0.32,
      };
    });
    return nodes;
  }, [merchants, walletName]);
}

function Orb({ node, pulse }: { node: Node; pulse: Flash | undefined }) {
  const ref = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (ref.current) ref.current.position.y = node.pos.y + Math.sin(t * 1.3 + node.pos.x) * 0.06;
    if (ring.current) {
      const age = pulse ? (Date.now() - pulse.born) / FLASH_MS : 1;
      const on = age < 1;
      ring.current.visible = on;
      if (on) {
        const s = 1 + age * 2.2;
        ring.current.scale.set(s, s, s);
        (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - age);
        (ring.current.material as THREE.MeshBasicMaterial).color.set(pulse!.color);
      }
    }
  });
  return (
    <group position={[node.pos.x, 0, node.pos.z]}>
      <mesh ref={ref} position={[0, node.pos.y, 0]}>
        <sphereGeometry args={[node.size, 48, 48]} />
        <meshStandardMaterial color={node.color} emissive={node.color} emissiveIntensity={0.9} roughness={0.25} metalness={0.2} />
        <Html center distanceFactor={7} position={[0, node.size + 0.45, 0]} style={{ pointerEvents: "none" }}>
          <div className="node-label">
            <strong>{node.label}</strong>
            {node.sub && <span>{node.sub}</span>}
          </div>
        </Html>
      </mesh>
      <mesh ref={ring} position={[0, node.pos.y, 0]} visible={false}>
        <sphereGeometry args={[node.size * 1.15, 32, 32]} />
        <meshBasicMaterial transparent opacity={0} wireframe />
      </mesh>
    </group>
  );
}

function Particle({ flow, nodes }: { flow: Flow; nodes: Record<string, Node> }) {
  const ref = useRef<THREE.Group>(null);
  const a = nodes[flow.from]?.pos;
  const b = nodes[flow.to]?.pos;
  const curve = useMemo(() => {
    if (!a || !b) return null;
    const mid = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 1.4, 0));
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }, [a, b]);
  useFrame(() => {
    if (!ref.current || !curve) return;
    const t = Math.min((Date.now() - flow.born) / FLOW_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    ref.current.position.copy(curve.getPoint(eased));
    ref.current.visible = t < 1;
  });
  if (!curve) return null;
  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[0.13, 20, 20]} />
        <meshBasicMaterial color={flow.color} />
      </mesh>
      <pointLight color={flow.color} intensity={6} distance={2.5} />
      {flow.label && (
        <Html center distanceFactor={9} position={[0, 0.35, 0]} style={{ pointerEvents: "none" }}>
          <div className="flow-label" style={{ borderColor: flow.color, color: flow.color }}>
            {flow.label}
          </div>
        </Html>
      )}
    </group>
  );
}

function Edges({ nodes }: { nodes: Record<string, Node> }) {
  const agent = nodes.agent.pos;
  return (
    <>
      {Object.values(nodes)
        .filter((n) => n.id !== "agent")
        .map((n) => (
          <Line key={n.id} points={[agent, n.pos]} color={n.id === "paypal" ? "#2f8cff" : "#3a3f5c"} lineWidth={1} dashed dashSize={0.15} gapSize={0.1} transparent opacity={0.6} />
        ))}
    </>
  );
}

export function Map3D({ nodes, flows, flashes }: { nodes: Record<string, Node>; flows: Flow[]; flashes: Flash[] }) {
  const latestFlash = (id: string) => flashes.filter((f) => f.node === id).at(-1);
  return (
    <Canvas camera={{ position: [0, 3.6, 9.2], fov: 50 }} dpr={[1, 2]}>
      <color attach="background" args={["#07080f"]} />
      <fog attach="fog" args={["#07080f", 9, 20]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[5, 6, 5]} intensity={40} />
      <Stars radius={40} depth={20} count={1500} factor={2} fade speed={0.6} />
      <gridHelper args={[16, 32, "#1a1d2e", "#11131f"]} position={[0, -1.6, 0]} />
      <Edges nodes={nodes} />
      {Object.values(nodes).map((n) => (
        <Orb key={n.id} node={n} pulse={latestFlash(n.id)} />
      ))}
      {flows.map((f) => (
        <Particle key={f.id} flow={f} nodes={nodes} />
      ))}
      <OrbitControls enablePan={false} autoRotate autoRotateSpeed={0.35} minDistance={5} maxDistance={14} maxPolarAngle={Math.PI / 2.1} />
    </Canvas>
  );
}

export const FLOW_LIFETIME_MS = Math.max(FLOW_MS, FLASH_MS) + 200;
