# Integration guide: ANPR, gates, payments

The Node API talks to hardware and providers only through adapters in `backend/src/integrations/`. Services never know which implementation is active.

## ANPR recognition engine

The engine is a **separate service** so you can use Python, OpenCV, YOLO and EasyOCR (GPU if needed) without touching the API.

Contract (`ANPR_MODE=http`, `ANPR_SERVICE_URL=http://anpr:8000`, optional `ANPR_SERVICE_TOKEN`):

```
POST /recognize        multipart/form-data, field "image" (jpeg/png/webp)
Authorization: Bearer <ANPR_SERVICE_TOKEN>   (if set)
200 {"plate": "RAB123C", "confidence": 0.93}      plate may be null when nothing is found
```

Sketch of a compliant service (not included, not tested here):

```python
# FastAPI: detect plate region (YOLO) -> crop -> EasyOCR -> normalize -> return plate + mean confidence
@app.post("/recognize")
async def recognize(image: UploadFile): ...
```

Behavior implemented by the API around the engine: stores the image and result per camera/gate, normalizes the plate, drops repeats from the same camera within `ANPR_DEDUP_SECONDS`, matches registry and active sessions, requires operator confirmation below the confidence threshold (setting `anpr.minConfidence`), allows manual correction (audited), and records failures with an alert. `autoProcess` only acts when confidence is sufficient and then still runs the normal access checks.

Cameras push snapshots to `POST /anpr/recognize` with a user token of a dedicated low-privilege account (an `ATTENDANT` bound to the facility). Rotate that credential like any other.

Simulation mode (`ANPR_MODE=simulation`) returns whatever plate the test console sends. Every event it creates carries `isSimulated=true` and the UI labels it.

## Gate controllers

`Gate.controllerType`:

- `SIMULATION`: returns an acknowledgement and states that no barrier moved.
- `HTTP`: the controller (or a small gateway in front of the PLC/relay board) must expose:
  - `POST {controllerUrl}/command` body `{"command":"OPEN|CLOSE|LOCK|UNLOCK"}` -> `200 {"ack": true}`
  - `GET {controllerUrl}/health` -> `200`

Rules the API enforces: offline/maintenance/error gates are never sent OPEN; a non-acknowledged or timed-out command is stored as `FAILED`, marks the gate `ERROR` and raises a critical notification; entry/exit through a gate that is not `ONLINE` is denied. For safety-critical sites, keep the physical safety logic (loop detectors, anti-crush) in the controller, not in this software.

To add another protocol (MQTT, Modbus, vendor SDK) implement `send` and `ping` in `integrations/gate-controllers/index.js` and register a new `controllerType`.

## Payment providers

Adapter contract is documented at the top of `integrations/payments/index.js`. To integrate MTN MoMo, Airtel Money or a card gateway:

1. Implement `initiate` (create the collection request), `verifyWebhook` (the provider's signature scheme), `parseWebhook` (map their payload to `{eventId, providerReference, status, amount}`) and `refund`.
2. Register it in `getProvider`/`getProviderByKey`, set `PAYMENT_MODE=live` and the secrets.
3. Configure the provider to call `POST https://<api>/api/v1/payments/webhooks/<provider-key>`.
4. Test with the provider's sandbox: success, decline, timeout, duplicate callback, amount mismatch.

Never store PINs, card numbers or CVVs. The frontend only sends a phone number; success is decided by the verified callback.

## E-mail (password reset)

`services/auth.js#requestPasswordReset` creates the token and currently logs that no e-mail adapter is configured. Send `https://<frontend>/reset-password?token=<token>` through your mail provider there, and keep returning the same generic response.
