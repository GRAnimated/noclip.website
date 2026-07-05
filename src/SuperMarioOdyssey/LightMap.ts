import { clamp } from '../MathHelpers.js';

// TODO: this is slop and still needs to be reviewed and could be moved to the GPU

export interface MaterialLightParam {
    isEnable: boolean;
    lightAngle: [number, number, number];
    lightScale: number;
    lightIntencity: number;
    lightDampPow: number;
    lightColor: [number, number, number, number];
}

export interface LightMapParam {
    name: string;
    isEnable: boolean;
    isEnableSphere: boolean;
    isEnableRing: boolean;
    isEnableLocalNormalMap: boolean;
    baseAngle: [number, number, number];
    rimColor: [number, number, number, number];
    rimWidth: number;
    rimPow: number;
    sphereAround: number;
    lightArray: MaterialLightParam[];
    raw: any;
}

export const LIGHT_MAP_SIZE = 128;
export const LIGHT_MAP_MIP_COUNT = 6;

const DEG_TO_RAD = Math.PI / 180.0;
const INV_PI = 1.0 / Math.PI;
const HDR_POWER = 4.0;
const DYNAMIC_RANGE = 1024.0;
const ENCODE_BASE = 0.25;

function getField(obj: any, name: string): any {
    if (obj === null || obj === undefined)
        return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, name))
        return obj[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(obj))
        if (key.toLowerCase() === lower)
            return obj[key];
    return undefined;
}

function unwrapValue(v: any): any {
    if (v !== null && typeof v === 'object') {
        if (Object.prototype.hasOwnProperty.call(v, 'Value')) return unwrapValue(v.Value);
        if (Object.prototype.hasOwnProperty.call(v, 'value')) return unwrapValue(v.value);
    }
    return v;
}

function readBool(obj: any, name: string, def: boolean): boolean {
    const v = unwrapValue(getField(obj, name));
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return def;
}

function readNumber(obj: any, name: string, def: number): number {
    const v = unwrapValue(getField(obj, name));
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    }
    return def;
}

function readString(obj: any, name: string, def: string): string {
    const v = unwrapValue(getField(obj, name));
    return typeof v === 'string' ? v : def;
}

function readVec3(obj: any, name: string, def: [number, number, number]): [number, number, number] {
    const v = unwrapValue(getField(obj, name));
    if (Array.isArray(v))
        return [Number(v[0] ?? def[0]), Number(v[1] ?? def[1]), Number(v[2] ?? def[2])];
    if (v !== null && typeof v === 'object')
        return [Number(unwrapValue(v.x ?? v.X ?? v.r ?? v.R) ?? def[0]), Number(unwrapValue(v.y ?? v.Y ?? v.g ?? v.G) ?? def[1]), Number(unwrapValue(v.z ?? v.Z ?? v.b ?? v.B) ?? def[2])];
    return def;
}

function readColor(obj: any, name: string, def: [number, number, number, number]): [number, number, number, number] {
    const v = unwrapValue(getField(obj, name));
    if (Array.isArray(v))
        return [Number(v[0] ?? def[0]), Number(v[1] ?? def[1]), Number(v[2] ?? def[2]), Number(v[3] ?? def[3])];
    if (v !== null && typeof v === 'object')
        return [Number(unwrapValue(v.r ?? v.R ?? v.x ?? v.X) ?? def[0]), Number(unwrapValue(v.g ?? v.G ?? v.y ?? v.Y) ?? def[1]), Number(unwrapValue(v.b ?? v.B ?? v.z ?? v.Z) ?? def[2]), Number(unwrapValue(v.a ?? v.A ?? v.w ?? v.W) ?? def[3])];
    return def;
}

function extractArray(v: any): any[] {
    v = unwrapValue(v);
    if (Array.isArray(v)) return v;
    if (v !== null && typeof v === 'object') {
        const candidates = ['LightArray', 'Array', 'array', 'Items', 'items', 'objs', 'Objects', 'objects'];
        for (const key of candidates) {
            const a = unwrapValue(v[key]);
            if (Array.isArray(a)) return a;
        }
        const numeric = Object.keys(v).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
        if (numeric.length > 0) return numeric.map((k) => v[k]);
    }
    return [];
}

export function parseMaterialLightParam(raw: any): MaterialLightParam {
    return {
        isEnable: readBool(raw, 'IsEnable', false),
        lightAngle: readVec3(raw, 'LightAngle', [0, 0, 0]),
        lightScale: readNumber(raw, 'LightScale', 0),
        lightIntencity: readNumber(raw, 'LightIntencity', 1),
        lightDampPow: readNumber(raw, 'LightDampPow', 1),
        lightColor: readColor(raw, 'LightColor', [1, 1, 1, 1]),
    };
}

export function parseLightMapParam(raw: any, fallbackName: string): LightMapParam {
    const root = raw?.root && typeof raw.root === 'object' ? raw.root : raw;
    const rawLightArray = extractArray(getField(root, 'LightArray'));

    // SMO LightMapList BYML stores the LightMapParam header as LightArray[0],
    // followed by up to 32 MaterialLightParam entries. This mirrors the game's
    // ParameterArray setup where LightMapParam itself is added before each light.
    const header = rawLightArray.length > 0 && getField(rawLightArray[0], 'Name') !== undefined ? rawLightArray[0] : root;
    const lightEntries = header === root ? rawLightArray : rawLightArray.slice(1);
    const lightArray = lightEntries.map(parseMaterialLightParam);

    return {
        name: readString(header, 'Name', fallbackName),
        isEnable: readBool(header, 'IsEnable', true),
        isEnableSphere: readBool(header, 'IsEnableSphere', false),
        isEnableRing: readBool(header, 'IsEnableRing', false),
        isEnableLocalNormalMap: readBool(header, 'IsEnableLocalNormalMap', false),
        baseAngle: readVec3(header, 'BaseAngle', [0, 0, 0]),
        rimColor: readColor(header, 'RimColor', [0, 0, 0, 1]),
        rimWidth: readNumber(header, 'RimWidth', 1),
        rimPow: readNumber(header, 'RimPow', 2),
        sphereAround: readNumber(header, 'SphereAround', 0.25),
        lightArray,
        raw,
    };
}

function saturate(v: number): number { return clamp(v, 0, 1); }
function dot(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: number[], b: number[]): [number, number, number] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function length(v: number[]): number { return Math.hypot(v[0], v[1], v[2]); }
function normalize(v: number[]): [number, number, number] { const l = length(v); return l > 1e-8 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1]; }
function add(a: number[], b: number[]): [number, number, number] { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(v: number[], s: number): [number, number, number] { return [v[0] * s, v[1] * s, v[2] * s]; }

function rotateAroundAxis(v: number[], axis: number[], rad: number): [number, number, number] {
    const a = normalize(axis);
    const c = Math.cos(rad), s = Math.sin(rad);
    const cr = cross(a, v);
    const d = dot(a, v);
    return [v[0] * c + cr[0] * s + a[0] * d * (1 - c), v[1] * c + cr[1] * s + a[1] * d * (1 - c), v[2] * c + cr[2] * s + a[2] * d * (1 - c)];
}

function rotateX(v: number[], deg: number): [number, number, number] { const r = deg * DEG_TO_RAD, c = Math.cos(r), s = Math.sin(r); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; }
function rotateY(v: number[], deg: number): [number, number, number] { const r = deg * DEG_TO_RAD, c = Math.cos(r), s = Math.sin(r); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
function rotateZ(v: number[], deg: number): [number, number, number] { const r = deg * DEG_TO_RAD, c = Math.cos(r), s = Math.sin(r); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; }

// Matches the game's al::calcDirFromLongitudeLatitude convention closely enough for light-map use.
function calcDirFromLongitudeLatitude(lonDeg: number, latDeg: number): [number, number, number] {
    const lon = lonDeg * DEG_TO_RAD, lat = latDeg * DEG_TO_RAD;
    const c = Math.cos(lat);
    return normalize([Math.sin(lon) * c, Math.sin(lat), Math.cos(lon) * c]);
}

function calcHalfVec(lightDir: number[], normal: number[], lightScaleRad: number, ring: boolean): [number, number, number] {
    const v = scale(normal, -1);
    let halfVec = normalize(add(v, lightDir));
    let axis = normalize(cross(normal, halfVec));
    let rad = lightScaleRad;
    if (!ring) {
        const maxRad = Math.acos(saturate(dot(scale(halfVec, -1), normal)));
        rad = Math.min(maxRad, rad);
    }
    halfVec = rotateAroundAxis(halfVec, axis, rad * 0.5);
    return normalize(halfVec);
}

function calcSpecularGGXFromDir(lightDir: number[], halfVec: number[], normal: number[], roughness: number): number {
    const NL = saturate(-dot(normal, lightDir));
    const NH = saturate(-dot(normal, halfVec));
    const alpha = roughness * roughness;
    const alphaX = alpha * alpha;
    const t = (NH * NH) * (alphaX - 1.0) + 1.0;
    const d = INV_PI * alphaX / (t * t);
    return NL * d;
}

export function calcHdrToLdr(hdr: [number, number, number, number]): [number, number, number, number] {
    let head = Math.max(hdr[0], hdr[1], hdr[2]);
    const baseRcp = 1.0 / ENCODE_BASE;
    head += (1.0 - (head * baseRcp) - Math.floor(1.0 - (head * baseRcp))) * ENCODE_BASE;
    head = Math.max(head, 1.0 / 256.0);
    let a = saturate(head / DYNAMIC_RANGE);
    a = Math.pow(a, 1.0 / HDR_POWER);
    return [hdr[0] / head, hdr[1] / head, hdr[2] / head, a];
}

export function calcLdrToHdr(ldr: ArrayLike<number>): [number, number, number, number] {
    const scale = Math.pow(ldr[3], HDR_POWER) * DYNAMIC_RANGE;
    return [ldr[0] * scale, ldr[1] * scale, ldr[2] * scale, scale];
}

function faceDirection(face: number, s: number, t: number): [number, number, number] {
    // alLightMapNormal.glsl's cube normal is approximately (1, -t, -s), and
    // alLightMap.glsl remaps that base normal per MRT face.
    const x = 1.0, y = -t, z = -s;
    switch (face) {
    case 0: return normalize([ x,  y, -z]);
    case 1: return normalize([-x,  y,  z]);
    case 2: return normalize([-z,  x,  y]);
    case 3: return normalize([-z, -x, -y]);
    case 4: return normalize([-z,  y, -x]);
    case 5: return normalize([ z,  y,  x]);
    default: return [0, 0, 1];
    }
}

function calcLightMapColor(param: LightMapParam, normal: [number, number, number], roughness: number, sphere: boolean): [number, number, number, number] {
    let r = 0, g = 0, b = 0, a = 0;
    for (const light of param.lightArray) {
        if (!light.isEnable)
            continue;
        let lightDir = calcDirFromLongitudeLatitude(light.lightAngle[0] + param.baseAngle[0], light.lightAngle[1] + param.baseAngle[1]);
        if (sphere) {
            lightDir = rotateX(lightDir, 0);
            lightDir = rotateY(lightDir, 0);
            lightDir = rotateZ(lightDir, 0);
        }
        const halfVec = calcHalfVec(lightDir, normal, light.lightScale * DEG_TO_RAD, param.isEnableRing);
        let intensity = calcSpecularGGXFromDir(lightDir, halfVec, normal, roughness);
        if (light.lightDampPow !== 1.0)
            intensity = Math.pow(saturate(intensity), light.lightDampPow);
        const lr = light.lightColor[0] * light.lightIntencity;
        const lg = light.lightColor[1] * light.lightIntencity;
        const lb = light.lightColor[2] * light.lightIntencity;
        const alpha = saturate(-dot(normal, halfVec));
        r += lr * intensity;
        g += lg * intensity;
        b += lb * intensity;
        a += alpha;
    }
    if (sphere) {
        const rim = Math.pow(saturate(param.rimWidth * (1.0 - Math.abs(normal[2]))), param.rimPow);
        r += param.rimColor[0] * rim;
        g += param.rimColor[1] * rim;
        b += param.rimColor[2] * rim;
        a += param.rimColor[3] * rim;
    }
    return [r, g, b, a];
}

export interface GeneratedLightMapCube {
    name: string;
    levels: Float32Array[];
    size: number;
    numLevels: number;
}

export interface GeneratedLightMapSphere {
    name: string;
    data: Float32Array;
    width: number;
    height: number;
}

export function generateLightMapCube(param: LightMapParam, name = `MaterialLight:${param.name}`): GeneratedLightMapCube {
    const levels: Float32Array[] = [];
    for (let mip = 0; mip < LIGHT_MAP_MIP_COUNT; mip++) {
        const size = Math.max(1, LIGHT_MAP_SIZE >>> mip);
        const roughness01 = saturate(mip / 5.0);
        const roughness = Math.min(roughness01 * roughness01, 1.0) * 0.94 + 0.06;
        const data = new Float32Array(size * size * 6 * 4);
        for (let face = 0; face < 6; face++) {
            for (let y = 0; y < size; y++) {
                const t = ((y + 0.5) / size) * 2 - 1;
                for (let x = 0; x < size; x++) {
                    const s = ((x + 0.5) / size) * 2 - 1;
                    const n = faceDirection(face, s, t);
                    const hdr = calcLightMapColor(param, n, roughness, false);
                    const o = ((face * size * size) + y * size + x) * 4;
                    // alLightMap.glsl writes raw lightmap color. alComposeLightMap.glsl
                    // later HDR-encodes the composed cube with CalcHdrToLdr.
                    data[o + 0] = hdr[0]; data[o + 1] = hdr[1]; data[o + 2] = hdr[2]; data[o + 3] = hdr[3];
                }
            }
        }
        levels.push(data);
    }
    return { name, levels, size: LIGHT_MAP_SIZE, numLevels: LIGHT_MAP_MIP_COUNT };
}

export function generateLightMapSphere(param: LightMapParam, name = `MaterialLightSphere:${param.name}`): GeneratedLightMapSphere {
    const width = LIGHT_MAP_SIZE, height = LIGHT_MAP_SIZE;
    const data = new Float32Array(width * height * 4);
    const roughness = 1.0;
    for (let y = 0; y < height; y++) {
        const ny = ((y + 0.5) / height) * 2 - 1;
        for (let x = 0; x < width; x++) {
            const scaleOffset = 1.0 + (param.sphereAround / width);
            const nx = (((x + 0.5) / width) * 2 - 1) * scaleOffset;
            const rr = nx * nx + (ny * scaleOffset) * (ny * scaleOffset);
            const nz = rr <= 1.0 ? Math.sqrt(Math.max(0, 1.0 - rr)) : 0;
            const normal = normalize([nx, -ny * scaleOffset, nz]);
            const hdr = calcLightMapColor(param, normal, roughness, true);
            const o = (y * width + x) * 4;
            // cTextureMaterialLightSphere is sampled raw by RenderMaterial_reference,
            // not decoded with CalcLdrToHdr.
            data[o + 0] = hdr[0]; data[o + 1] = hdr[1]; data[o + 2] = hdr[2]; data[o + 3] = hdr[3];
        }
    }
    return { name, data, width, height };
}

function directionToFaceUV(dir: [number, number, number]): [number, number, number] {
    const x = dir[0], y = dir[1], z = dir[2];
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face = 0, s = 0, t = 0;
    if (ax >= ay && ax >= az) {
        if (x >= 0) { face = 0; s = z / x; t = -y / x; }
        else        { face = 1; s = z / x; t =  y / x; }
    } else if (ay >= ax && ay >= az) {
        if (y >= 0) { face = 2; s =  x / y; t = -z / y; }
        else        { face = 3; s = -x / y; t = -z / y; }
    } else {
        if (z >= 0) { face = 5; s = -x / z; t = -y / z; }
        else        { face = 4; s = -x / z; t =  y / z; }
    }
    return [face, saturate((s + 1.0) * 0.5), saturate((t + 1.0) * 0.5)];
}

function sampleCubeLevelBilinear(level: Float32Array, size: number, dir: [number, number, number]): [number, number, number, number] {
    const [face, u, v] = directionToFaceUV(dir);
    const fx = u * size - 0.5;
    const fy = v * size - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const xA = clamp(x0, 0, size - 1), xB = clamp(x0 + 1, 0, size - 1);
    const yA = clamp(y0, 0, size - 1), yB = clamp(y0 + 1, 0, size - 1);
    const sample = (x: number, y: number, c: number): number => level[((face * size * size) + y * size + x) * 4 + c];
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const a = sample(xA, yA, c) * (1 - tx) + sample(xB, yA, c) * tx;
        const b = sample(xA, yB, c) * (1 - tx) + sample(xB, yB, c) * tx;
        out[c] = a * (1 - ty) + b * ty;
    }
    return out;
}

function sampleCubeLod(levels: Float32Array[], baseSize: number, dir: [number, number, number], lod: number): [number, number, number, number] {
    const l0 = clamp(Math.floor(lod), 0, levels.length - 1);
    const l1 = clamp(l0 + 1, 0, levels.length - 1);
    const t = clamp(lod - l0, 0, 1);
    const s0 = Math.max(1, baseSize >>> l0), s1 = Math.max(1, baseSize >>> l1);
    const a = sampleCubeLevelBilinear(levels[l0], s0, dir);
    if (l0 === l1 || t <= 0)
        return a;
    const b = sampleCubeLevelBilinear(levels[l1], s1, dir);
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
        a[3] * (1 - t) + b[3] * t,
    ];
}

function encodeRawLightMapCube(light: GeneratedLightMapCube, name: string): GeneratedLightMapCube {
    const levels = light.levels.map((level) => {
        const out = new Float32Array(level.length);
        for (let i = 0; i < level.length; i += 4) {
            const ldr = calcHdrToLdr([level[i + 0], level[i + 1], level[i + 2], level[i + 3]]);
            out[i + 0] = ldr[0]; out[i + 1] = ldr[1]; out[i + 2] = ldr[2]; out[i + 3] = ldr[3];
        }
        return out;
    });
    return { ...light, name, levels };
}

export function composeLightMapCube(light: GeneratedLightMapCube, cubeLevels: Float32Array[] | null, cubeSize: number, name: string): GeneratedLightMapCube {
    if (cubeLevels === null)
        return encodeRawLightMapCube(light, name);
    const levels: Float32Array[] = [];
    for (let mip = 0; mip < light.numLevels; mip++) {
        const size = Math.max(1, light.size >>> mip);
        const roughness01 = saturate(mip / 5.0);
        const roughness = Math.min(roughness01 * roughness01, 1.0) * 0.94 + 0.06;
        const cubeLod = 5.0 * roughness;
        const lightLod = Math.sqrt(roughness) * 5.0;
        const out = new Float32Array(size * size * 6 * 4);
        for (let face = 0; face < 6; face++) {
            for (let y = 0; y < size; y++) {
                const tv = ((y + 0.5) / size) * 2 - 1;
                for (let x = 0; x < size; x++) {
                    const su = ((x + 0.5) / size) * 2 - 1;
                    const dir = faceDirection(face, su, tv);
                    const lightHdr = sampleCubeLod(light.levels, light.size, dir, lightLod);
                    const cubeLdr = sampleCubeLod(cubeLevels, cubeSize, dir, cubeLod);
                    const ch = calcLdrToHdr(cubeLdr);
                    const ldr = calcHdrToLdr([lightHdr[0] + ch[0], lightHdr[1] + ch[1], lightHdr[2] + ch[2], 1]);
                    const o = ((face * size * size) + y * size + x) * 4;
                    out[o + 0] = ldr[0]; out[o + 1] = ldr[1]; out[o + 2] = ldr[2]; out[o + 3] = ldr[3];
                }
            }
        }
        levels.push(out);
    }
    return { name, levels, size: light.size, numLevels: light.numLevels };
}
