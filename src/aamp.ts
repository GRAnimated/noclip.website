import ArrayBufferSlice from './ArrayBufferSlice.js';
import { assert, readString } from './util.js';

export enum AAMPParameterType {
    Bool = 0,
    F32 = 1,
    Int = 2,
    Vec2 = 3,
    Vec3 = 4,
    Vec4 = 5,
    Color = 6,
    String32 = 7,
    String64 = 8,
    Curve1 = 9,
    Curve2 = 10,
    Curve3 = 11,
    Curve4 = 12,
    BufferInt = 13,
    BufferF32 = 14,
    String256 = 15,
    Quat = 16,
    U32 = 17,
    BufferU32 = 18,
    BufferBinary = 19,
    StringRef = 20,
    Pointer = 21,
}

export type AAMPCurve = {
    numUses: number;
    curveType: number;
    values: number[];
};

export type AAMPParameter = {
    nameHash: number;
    name: string;
    type: AAMPParameterType;
    typeName: string;
    dataOffset: number;
    value: unknown;
};

export type AAMPObject = {
    nameHash: number;
    name: string;
    parameters: AAMPParameter[];
};

export type AAMPList = {
    nameHash: number;
    name: string;
    lists: AAMPList[];
    objects: AAMPObject[];
};

export type AAMP = {
    version: number;
    flags: number;
    littleEndian: boolean;
    fileSize: number;
    parameterIOVersion: number;
    parameterIOType: string;
    root: AAMPList;
    lists: AAMPList[];
    objects: AAMPObject[];
};

const knownNames = new Map<number, string>();

function makeCRCTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++)
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
}

const crcTable = makeCRCTable();

export function calcAAMPNameHash(name: string): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < name.length; i++)
        c = crcTable[(c ^ name.charCodeAt(i)) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

export function registerAAMPName(name: string): void {
    knownNames.set(calcAAMPNameHash(name), name);
}

[
    'param_root', 'xml',
    // baglcc / baglccr color correction
    'enable', 'hue', 'saturation', 'brightness', 'gamma',
    'toycam_enable', 'toycam_offset1', 'toycam_offset2', 'toycam_level1', 'toycam_level2',
    'toycam_saturation1', 'toycam_saturation2', 'toycam_brightness', 'toycam_contrast', 'toycam_mul_color',
    'level',
    // known agl pfx names
    'Bloom', 'DepthOfField', 'FlareFilter', 'GlareFilter', 'GodRay', 'LightStreak', 'ReduceBuffer',
    'threshold', 'intensity', 'blur_num', 'range', 'radius', 'blend_rate', 'power', 'scale', 'offset',
].forEach(registerAAMPName);

function hashName(hash: number): string {
    return knownNames.get(hash) ?? `#${hash.toString(16).padStart(8, '0')}`;
}

function typeName(type: number): string {
    return AAMPParameterType[type] ?? `Unknown${type}`;
}

function readVec(view: DataView, offs: number, n: number, littleEndian: boolean): number[] {
    const v: number[] = [];
    for (let i = 0; i < n; i++)
        v.push(view.getFloat32(offs + 0x04 * i, littleEndian));
    return v;
}

function readFixedString(buffer: ArrayBufferSlice, offs: number, length: number): string {
    return readString(buffer, offs, length, true, 'utf8');
}

function readBuffer(view: DataView, offs: number, littleEndian: boolean, readElement: (offs: number) => unknown): unknown[] {
    const count = view.getUint32(offs, littleEndian);
    const values: unknown[] = [];
    for (let i = 0; i < count; i++)
        values.push(readElement(offs + 0x04 + 0x04 * i));
    return values;
}

function readCurve(view: DataView, offs: number, littleEndian: boolean): AAMPCurve {
    const values: number[] = [];
    for (let i = 0; i < 30; i++)
        values.push(view.getFloat32(offs + 0x08 + 0x04 * i, littleEndian));
    return {
        numUses: view.getUint32(offs + 0x00, littleEndian),
        curveType: view.getUint32(offs + 0x04, littleEndian),
        values,
    };
}

function readParameterValue(buffer: ArrayBufferSlice, view: DataView, type: AAMPParameterType, offs: number, littleEndian: boolean): unknown {
    switch (type) {
    case AAMPParameterType.Bool:
        return view.getUint32(offs, littleEndian) !== 0;
    case AAMPParameterType.F32:
        return view.getFloat32(offs, littleEndian);
    case AAMPParameterType.Int:
        return view.getInt32(offs, littleEndian);
    case AAMPParameterType.Vec2:
        return readVec(view, offs, 2, littleEndian);
    case AAMPParameterType.Vec3:
        return readVec(view, offs, 3, littleEndian);
    case AAMPParameterType.Vec4:
    case AAMPParameterType.Color:
    case AAMPParameterType.Quat:
        return readVec(view, offs, 4, littleEndian);
    case AAMPParameterType.String32:
        return readFixedString(buffer, offs, 32);
    case AAMPParameterType.String64:
        return readFixedString(buffer, offs, 64);
    case AAMPParameterType.String256:
        return readFixedString(buffer, offs, 256);
    case AAMPParameterType.StringRef:
        return readFixedString(buffer, offs, 0x10000);
    case AAMPParameterType.Curve1:
    case AAMPParameterType.Curve2:
    case AAMPParameterType.Curve3:
    case AAMPParameterType.Curve4: {
        const count = type - AAMPParameterType.Curve1 + 1;
        const curves: AAMPCurve[] = [];
        for (let i = 0; i < count; i++)
            curves.push(readCurve(view, offs + 0x80 * i, littleEndian));
        return curves;
    }
    case AAMPParameterType.U32:
        return view.getUint32(offs, littleEndian);
    case AAMPParameterType.BufferInt:
        return readBuffer(view, offs, littleEndian, (o) => view.getInt32(o, littleEndian));
    case AAMPParameterType.BufferF32:
        return readBuffer(view, offs, littleEndian, (o) => view.getFloat32(o, littleEndian));
    case AAMPParameterType.BufferU32:
        return readBuffer(view, offs, littleEndian, (o) => view.getUint32(o, littleEndian));
    case AAMPParameterType.BufferBinary: {
        const count = view.getUint32(offs, littleEndian);
        const values: number[] = [];
        for (let i = 0; i < count; i++)
            values.push(view.getUint8(offs + 0x04 + i));
        return values;
    }
    default:
        return { rawU32: view.getUint32(offs, littleEndian) };
    }
}

export function parse(buffer: ArrayBufferSlice): AAMP {
    const view = buffer.createDataView();
    assert(readString(buffer, 0x00, 0x04) === 'AAMP');

    const version = view.getUint32(0x04, true);
    assert(version === 2);
    const flags = view.getUint32(0x08, true);
    const littleEndian = !!(flags & 0x01);
    const fileSize = view.getUint32(0x0C, littleEndian);
    const parameterIOVersion = view.getUint32(0x10, littleEndian);
    const parameterIOOffset = 0x30 + view.getUint32(0x14, littleEndian);
    const listCount = view.getUint32(0x18, littleEndian);
    const objectCount = view.getUint32(0x1C, littleEndian);
    const parameterCount = view.getUint32(0x20, littleEndian);
    const dataSectionSize = view.getUint32(0x24, littleEndian);

    const parameterIOType = readString(buffer, 0x30, parameterIOOffset - 0x30, true, 'utf8');
    const listBase = parameterIOOffset;
    const objectBase = listBase + listCount * 0x0C;
    const parameterBase = objectBase + objectCount * 0x08;
    const dataBase = parameterBase + parameterCount * 0x08;
    const stringBase = dataBase + dataSectionSize;

    const lists: AAMPList[] = [];
    const objects: AAMPObject[] = [];

    function dataOffsetForParameter(parameterOffs: number, flags: number): number {
        const rel = (flags & 0x00FFFFFF) * 4;
        return parameterOffs + rel;
    }

    function parseObject(index: number): AAMPObject {
        const offs = objectBase + index * 0x08;
        const nameHash = view.getUint32(offs + 0x00, littleEndian);
        const childInfo = view.getUint32(offs + 0x04, littleEndian);
        const parameterOffs = offs + ((childInfo & 0xFFFF) * 4);
        const childParameterCount = childInfo >>> 16;
        const parameters: AAMPParameter[] = [];

        for (let i = 0; i < childParameterCount; i++) {
            const pOffs = parameterOffs + i * 0x08;
            const pNameHash = view.getUint32(pOffs + 0x00, littleEndian);
            const pInfo = view.getUint32(pOffs + 0x04, littleEndian);
            const type = (pInfo >>> 24) as AAMPParameterType;
            const dataOffset = dataOffsetForParameter(pOffs, pInfo);
            parameters.push({
                nameHash: pNameHash,
                name: hashName(pNameHash),
                type,
                typeName: typeName(type),
                dataOffset,
                value: readParameterValue(buffer, view, type, dataOffset, littleEndian),
            });
        }

        return { nameHash, name: hashName(nameHash), parameters };
    }

    function parseList(index: number): AAMPList {
        const offs = listBase + index * 0x0C;
        const nameHash = view.getUint32(offs + 0x00, littleEndian);
        const childListInfo = view.getUint32(offs + 0x04, littleEndian);
        const childObjectInfo = view.getUint32(offs + 0x08, littleEndian);
        const childListOffs = offs + ((childListInfo & 0xFFFF) * 4);
        const childListCount = childListInfo >>> 16;
        const childObjectOffs = offs + ((childObjectInfo & 0xFFFF) * 4);
        const childObjectCount = childObjectInfo >>> 16;

        const childLists: AAMPList[] = [];
        for (let i = 0; i < childListCount; i++)
            childLists.push(parseList((childListOffs - listBase) / 0x0C + i));

        const childObjects: AAMPObject[] = [];
        for (let i = 0; i < childObjectCount; i++)
            childObjects.push(parseObject((childObjectOffs - objectBase) / 0x08 + i));

        return { nameHash, name: hashName(nameHash), lists: childLists, objects: childObjects };
    }

    for (let i = 0; i < objectCount; i++)
        objects.push(parseObject(i));
    for (let i = 0; i < listCount; i++)
        lists.push(parseList(i));

    assert(fileSize === 0 || fileSize <= buffer.byteLength);
    return { version, flags, littleEndian, fileSize, parameterIOVersion, parameterIOType, root: lists[0], lists, objects };
}
