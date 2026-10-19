import { z } from 'zod';
import { isPlausiblePlate, normalizePlate } from '../utils/plate.js';

const money = z.coerce.number().nonnegative().max(1e9);
const optStr = (max = 200) => z.string().trim().max(max).optional().nullable();

export const SPACE_TYPES = ['STANDARD', 'MOTORCYCLE', 'ACCESSIBLE', 'EV', 'RESERVED', 'VIP'];
export const SPACE_STATUSES = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'OUT_OF_SERVICE'];
export const VEHICLE_TYPES = ['CAR', 'MOTORCYCLE', 'BUS', 'TRUCK', 'OTHER'];
export const DEVICE_STATUSES = ['ONLINE', 'OFFLINE', 'MAINTENANCE', 'ERROR'];

export const facilitySchema = z.object({
  code: z.string().trim().min(2).max(20).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  address: optStr(),
  city: optStr(80),
  timezone: z.string().max(60).default('Africa/Kigali'),
  currency: z.string().length(3).default('RWF'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  lowAvailabilityThreshold: z.coerce.number().int().min(0).max(100).default(10),
  allowUnassignedSpace: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const zoneSchema = z.object({
  facilityId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  floor: optStr(30),
  section: optStr(30),
});

export const spaceSchema = z.object({
  facilityId: z.string().min(1),
  zoneId: z.string().nullable().optional(),
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  type: z.enum(SPACE_TYPES).default('STANDARD'),
  status: z.enum(SPACE_STATUSES).default('AVAILABLE'),
  notes: optStr(300),
});

export const bulkSpacesSchema = z.object({
  facilityId: z.string().min(1),
  zoneId: z.string().nullable().optional(),
  prefix: z.string().trim().max(10).default(''),
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
  pad: z.coerce.number().int().min(0).max(5).default(2),
  type: z.enum(SPACE_TYPES).default('STANDARD'),
}).refine((v) => v.to >= v.from && v.to - v.from < 500, { message: 'Range must be 1-500 spaces', path: ['to'] });

export const cameraSchema = z.object({
  facilityId: z.string().min(1),
  gateId: z.string().nullable().optional(),
  name: z.string().trim().min(2).max(80),
  streamUrl: z.string().url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
  status: z.enum(DEVICE_STATUSES).default('ONLINE'),
  isSimulated: z.boolean().default(true),
});

export const gateSchema = z.object({
  facilityId: z.string().min(1),
  name: z.string().trim().min(2).max(80),
  direction: z.enum(['ENTRY', 'EXIT']),
  status: z.enum(DEVICE_STATUSES).default('ONLINE'),
  controllerType: z.enum(['SIMULATION', 'HTTP']).default('SIMULATION'),
  controllerUrl: z.string().url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
}).refine((v) => v.controllerType !== 'HTTP' || v.controllerUrl, { message: 'controllerUrl is required for HTTP controllers', path: ['controllerUrl'] });

export const gateUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  direction: z.enum(['ENTRY', 'EXIT']).optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  controllerType: z.enum(['SIMULATION', 'HTTP']).optional(),
  controllerUrl: z.string().url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
});

const SERVICES = ['PARKING', 'GARAGE', 'CAR_WASH'];
const UNITS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'VISIT'];
export const rateSchema = z.object({
  service: z.enum(SERVICES).default('PARKING'),
  facilityId: z.string().nullable().optional(),
  vehicleType: z.enum(VEHICLE_TYPES).nullable().optional(),
  unit: z.enum(UNITS).default('HOUR'),
  startPrice: z.coerce.number().min(100, 'Start price must be at least 100 RWF').max(1e9),
  increment: z.coerce.number().min(0).max(1e9).default(0),
  cap: z.coerce.number().min(0).max(1e9).nullable().optional(),
  isActive: z.boolean().default(true),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
}).refine((v) => v.cap == null || v.cap >= v.startPrice, { message: 'The cap cannot be below the start price', path: ['cap'] })
  .refine((v) => (v.service === 'PARKING' ? v.unit === 'HOUR' : v.service === 'CAR_WASH' ? v.unit === 'VISIT' : ['DAY', 'WEEK', 'MONTH'].includes(v.unit)),
    { message: 'Parking is billed per hour, garage per day/week/month, car wash per visit', path: ['unit'] });

// PATCH accepts any subset; the cross-field rules are re-checked against the merged record in the route hook.
export const rateUpdateSchema = z.object({
  service: z.enum(SERVICES).optional(),
  facilityId: z.string().nullable().optional(),
  vehicleType: z.enum(VEHICLE_TYPES).nullable().optional(),
  unit: z.enum(UNITS).optional(),
  startPrice: z.coerce.number().min(100, 'Start price must be at least 100 RWF').max(1e9).optional(),
  increment: z.coerce.number().min(0).max(1e9).optional(),
  cap: z.coerce.number().min(0).max(1e9).nullable().optional(),
  isActive: z.boolean().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
});

const ownerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  nationalId: z.string().trim().max(30).optional().nullable(),
});

const vehicleFields = (d) => ({
  plate: z.string().trim().min(3).max(20).refine((p) => isPlausiblePlate(normalizePlate(p)), 'Plate must have 3-12 letters or digits'),
  type: d ? z.enum(VEHICLE_TYPES).default('CAR') : z.enum(VEHICLE_TYPES).optional(),
  make: optStr(60),
  model: optStr(60),
  color: optStr(40),
  status: d ? z.enum(['REGISTERED', 'AUTHORIZED', 'RESTRICTED']).default('REGISTERED') : z.enum(['REGISTERED', 'AUTHORIZED', 'RESTRICTED']).optional(),
  restrictionReason: optStr(300),
  owner: ownerSchema.optional().nullable(),
});
const vehicleBase = z.object(vehicleFields(true));
const vehiclePatch = z.object({ ...vehicleFields(false), plate: vehicleFields(true).plate.optional() });

const restrictedNeedsReason = (v) => v.status !== 'RESTRICTED' || !!v.restrictionReason;
const reasonMsg = { message: 'A reason is required for restricted vehicles', path: ['restrictionReason'] };

export const vehicleCreateSchema = vehicleBase.refine(restrictedNeedsReason, reasonMsg).transform(({ plate, owner, ...rest }) => ({
  ...rest,
  plate: normalizePlate(plate),
  plateDisplay: plate.trim().toUpperCase(),
  ...(owner ? { owner: { create: owner } } : {}),
}));

export const vehicleUpdateSchema = vehiclePatch.refine(restrictedNeedsReason, reasonMsg).transform(({ plate, owner, ...rest }) => ({
  ...rest,
  ...(plate ? { plate: normalizePlate(plate), plateDisplay: plate.trim().toUpperCase() } : {}),
  ...(owner ? { owner: { create: owner } } : {}),
}));
