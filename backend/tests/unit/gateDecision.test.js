import { describe, expect, it } from 'vitest';
import { decideAccess } from '../../src/services/gateDecision.js';

const base = { direction: 'ENTRY', plate: 'RAB123C', gateStatus: 'ONLINE' };

describe('decideAccess: entry', () => {
  it('allows a normal entry', () => {
    expect(decideAccess(base)).toMatchObject({ allow: true, code: 'OK' });
  });
  it('denies without a plate', () => {
    expect(decideAccess({ ...base, plate: '' })).toMatchObject({ allow: false, code: 'NO_PLATE' });
  });
  it.each(['OFFLINE', 'MAINTENANCE', 'ERROR'])('denies when the gate is %s (fail closed)', (gateStatus) => {
    expect(decideAccess({ ...base, gateStatus })).toMatchObject({ allow: false, code: 'GATE_NOT_ONLINE' });
  });
  it('allows desk operation with no gate', () => {
    expect(decideAccess({ ...base, gateStatus: undefined }).allow).toBe(true);
  });
  it('denies restricted vehicles with the stored reason', () => {
    const d = decideAccess({ ...base, vehicle: { status: 'RESTRICTED', restrictionReason: 'Unpaid fees' } });
    expect(d).toMatchObject({ allow: false, code: 'RESTRICTED_VEHICLE', reason: 'Unpaid fees' });
  });
  it('denies a vehicle that is already inside', () => {
    expect(decideAccess({ ...base, activeSession: { id: 's1' } })).toMatchObject({ allow: false, code: 'ALREADY_INSIDE' });
  });
  it('denies when full unless a reservation exists', () => {
    expect(decideAccess({ ...base, hasCapacity: false })).toMatchObject({ allow: false, code: 'FACILITY_FULL' });
    expect(decideAccess({ ...base, hasCapacity: false, hasReservation: true }).allow).toBe(true);
  });
  it('can require registration', () => {
    expect(decideAccess({ ...base, allowUnregistered: false })).toMatchObject({ allow: false, code: 'UNREGISTERED_VEHICLE' });
    expect(decideAccess({ ...base, allowUnregistered: false, hasPermit: true }).allow).toBe(true);
    expect(decideAccess({ ...base, allowUnregistered: false, vehicle: { status: 'REGISTERED' } }).allow).toBe(true);
  });
  it('requires operator confirmation for low recognition confidence', () => {
    const d = decideAccess({ ...base, confidence: 0.5, minConfidence: 0.85 });
    expect(d).toMatchObject({ allow: false, code: 'LOW_CONFIDENCE', requiresConfirmation: true });
  });
  it('denies an inactive facility', () => {
    expect(decideAccess({ ...base, facilityActive: false })).toMatchObject({ allow: false, code: 'FACILITY_INACTIVE' });
  });
  it('denies an unknown direction', () => {
    expect(decideAccess({ ...base, direction: 'SIDEWAYS' }).allow).toBe(false);
  });
});

describe('decideAccess: exit', () => {
  const exit = { ...base, direction: 'EXIT', activeSession: { id: 's1' } };
  it('allows when paid', () => {
    expect(decideAccess({ ...exit, balanceDue: 0 }).allow).toBe(true);
  });
  it('denies without an active session', () => {
    expect(decideAccess({ ...exit, activeSession: null })).toMatchObject({ allow: false, code: 'NO_ACTIVE_SESSION' });
  });
  it('denies while a balance is due', () => {
    expect(decideAccess({ ...exit, balanceDue: '1500.00' })).toMatchObject({ allow: false, code: 'PAYMENT_REQUIRED' });
  });
});
