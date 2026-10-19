// Gate controller adapters.
//
// The software NEVER assumes a barrier moved. Each adapter must return an explicit acknowledgement
// from the controller; anything else is recorded as FAILED and access is not reported as granted.
//
// Contract: send(gate, command) -> { acknowledged: boolean, simulated: boolean, detail?: string }
//           ping(gate)          -> { online: boolean, detail?: string }
//
// HTTP controllers must implement:
//   POST {controllerUrl}/command  { "command": "OPEN" }  -> 200 { "ack": true }
//   GET  {controllerUrl}/health                          -> 200
import { env } from '../../config/env.js';

const simulation = {
  async send(_gate, command) {
    return { acknowledged: true, simulated: true, detail: `SIMULATED ${command}: no physical barrier was operated` };
  },
  async ping() {
    return { online: true, detail: 'SIMULATED controller' };
  },
};

const http = {
  async send(gate, command) {
    if (!gate.controllerUrl) return { acknowledged: false, simulated: false, detail: 'No controller URL configured' };
    try {
      const res = await fetch(`${gate.controllerUrl.replace(/\/$/, '')}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(env.GATE_COMMAND_TIMEOUT_MS),
      });
      if (!res.ok) return { acknowledged: false, simulated: false, detail: `Controller responded ${res.status}` };
      const body = await res.json().catch(() => ({}));
      return { acknowledged: body.ack === true, simulated: false, detail: body.ack === true ? 'Controller acknowledged' : 'Controller did not acknowledge' };
    } catch (err) {
      return { acknowledged: false, simulated: false, detail: `Controller unreachable: ${err.name}` };
    }
  },
  async ping(gate) {
    if (!gate.controllerUrl) return { online: false, detail: 'No controller URL configured' };
    try {
      const res = await fetch(`${gate.controllerUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(env.GATE_COMMAND_TIMEOUT_MS) });
      return { online: res.ok, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { online: false, detail: `Unreachable: ${err.name}` };
    }
  },
};

export const getController = (gate) => (gate.controllerType === 'HTTP' ? http : simulation);
