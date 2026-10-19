// Access decision for a gate or desk. Pure and deny-by-default:
// anything that cannot be positively verified results in allow=false.
//
// Returns { allow, code, reason, requiresConfirmation? }

export const DENY = Object.freeze({
  NO_PLATE: 'NO_PLATE',
  GATE_NOT_ONLINE: 'GATE_NOT_ONLINE',
  FACILITY_INACTIVE: 'FACILITY_INACTIVE',
  RESTRICTED: 'RESTRICTED_VEHICLE',
  UNREGISTERED: 'UNREGISTERED_VEHICLE',
  ALREADY_INSIDE: 'ALREADY_INSIDE',
  FULL: 'FACILITY_FULL',
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  UNKNOWN_DIRECTION: 'UNKNOWN_DIRECTION',
});

const deny = (code, reason, extra = {}) => ({ allow: false, code, reason, ...extra });

export function decideAccess({
  direction,
  plate,
  gateStatus, // undefined = manual desk operation (no gate involved)
  facilityActive = true,
  vehicle = null,
  hasPermit = false,
  allowUnregistered = true,
  activeSession = null,
  hasCapacity = true,
  hasReservation = false,
  balanceDue = 0,
  confidence = null,
  minConfidence = 0.85,
}) {
  if (!plate) return deny(DENY.NO_PLATE, 'No license plate was provided or recognized');
  if (direction !== 'ENTRY' && direction !== 'EXIT') return deny(DENY.UNKNOWN_DIRECTION, 'Unknown direction');
  if (gateStatus !== undefined && gateStatus !== 'ONLINE') {
    return deny(DENY.GATE_NOT_ONLINE, `Gate is ${String(gateStatus).toLowerCase()}; access cannot be verified`);
  }
  if (!facilityActive) return deny(DENY.FACILITY_INACTIVE, 'Facility is not active');
  if (vehicle?.status === 'RESTRICTED') {
    return deny(DENY.RESTRICTED, vehicle.restrictionReason || 'Vehicle is restricted');
  }
  if (confidence != null && confidence < minConfidence) {
    return deny(DENY.LOW_CONFIDENCE, 'Plate recognition confidence is too low; operator confirmation required', {
      requiresConfirmation: true,
    });
  }

  if (direction === 'ENTRY') {
    if (activeSession) return deny(DENY.ALREADY_INSIDE, 'Vehicle already has an active parking session');
    if (!vehicle && !hasPermit && !allowUnregistered) {
      return deny(DENY.UNREGISTERED, 'Only registered vehicles may enter this facility');
    }
    if (!hasCapacity && !hasReservation) return deny(DENY.FULL, 'No available space');
    return { allow: true, code: 'OK', reason: 'Entry authorized', authorized: vehicle?.status === 'AUTHORIZED' || hasPermit };
  }

  // EXIT
  if (!activeSession) return deny(DENY.NO_ACTIVE_SESSION, 'No active parking session for this vehicle');
  if (Number(balanceDue) > 0) return deny(DENY.PAYMENT_REQUIRED, `Outstanding balance of ${balanceDue}`);
  return { allow: true, code: 'OK', reason: 'Exit authorized' };
}
