
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { readString, assert } from "../util.js";
import { isMarkerLittleEndian, readBinStr } from "./bfres.js";
import { ImageDimension, ImageFormat, ImageStorageDimension, TileMode, getChannelFormat } from "./nngfx_enum.js";
import { getFormatBlockHeight, isChannelFormatSupported } from "./tegra_texture.js";

export interface BNTX {
    textures: BRTI[];
}

export interface BRTI {
    name: string;
    imageDimension: ImageDimension;
    imageFormat: ImageFormat;
    width: number;
    height: number;
    depth: number;
    arraySize: number;
    mipBuffers: ArrayBufferSlice[] | ArrayBufferSlice[][];
    blockHeightLog2: number;
}

function parseBRTI(buffer: ArrayBufferSlice, offs: number, littleEndian: boolean): BRTI | null {
    const view = buffer.createDataView();

    assert(readString(buffer, offs + 0x00, 0x04) === 'BRTI');

    const name = readBinStr(buffer, view.getUint32(offs + 0x60, littleEndian), littleEndian);
    const flag = view.getUint8(offs + 0x10);
    const imageStorageDimension: ImageStorageDimension = view.getUint8(offs + 0x11);
    const tileMode: TileMode = view.getUint16(offs + 0x12, littleEndian);
    assert(tileMode === TileMode.Optimal);
    const swizzle = view.getUint16(offs + 0x14, littleEndian);
    const mipCount = view.getUint16(offs + 0x16, littleEndian);
    const multisampleCount = view.getUint16(offs + 0x18, littleEndian);
    assert(multisampleCount === 1);
    const imageFormat: ImageFormat = view.getUint32(offs + 0x1C, littleEndian);
    const gpuAccessFlags = view.getUint32(offs + 0x20, littleEndian);
    const width = view.getUint32(offs + 0x24, littleEndian);
    const height = view.getUint32(offs + 0x28, littleEndian);
    const depth = view.getUint32(offs + 0x2C, littleEndian);
    const arraySize = view.getUint32(offs + 0x30, littleEndian);
    // layout, the first element of which appears to be blockHeightLog2
    const blockHeightLog2 = view.getUint32(offs + 0x34, littleEndian);
    const channelFormat = getChannelFormat(imageFormat);
    if (!isChannelFormatSupported(channelFormat))
        return null;

    const textureDataSize = view.getUint32(offs + 0x50, littleEndian);
    const alignment = view.getUint32(offs + 0x54, littleEndian);
    const channelMapping = view.getUint32(offs + 0x58, littleEndian);
    const imageDimension = view.getUint8(offs + 0x5C);

    const dataOffsets: number[] = [];
    let dataOffsTableIdx = view.getUint32(offs + 0x70, littleEndian);
    for (let i = 0; i < mipCount; i++) {
        dataOffsets.push(view.getUint32(dataOffsTableIdx + 0x00, littleEndian));
        dataOffsTableIdx += 0x08;
    }

    let mipBuffers: ArrayBufferSlice[] | ArrayBufferSlice[][];
    if (arraySize > 1) {
        // fix for every cubemap face being face 0:
        // bntx stores array/cubemap textures as one mip chain per array layer
        // the mip offset table points into layer 0
        // subsequent layers are offset by the per-layer chain size

        const layerSize = textureDataSize / arraySize;
        const mipBufferArrays: ArrayBufferSlice[][] = [];
        for (let mip = 0; mip < mipCount; mip++) {
            const mipSize = mip < mipCount - 1 ? dataOffsets[mip + 1] - dataOffsets[mip] : layerSize - (dataOffsets[mip] - dataOffsets[0]);
            const layers: ArrayBufferSlice[] = [];
            for (let layer = 0; layer < arraySize; layer++) {
                const layerBase = layer * layerSize;
                layers.push(buffer.slice(layerBase + dataOffsets[mip], layerBase + dataOffsets[mip] + mipSize));
            }
            mipBufferArrays.push(layers);
        }
        mipBuffers = mipBufferArrays;
    } else {
        const mipBufferArray: ArrayBufferSlice[] = [];
        for (let i = 0; i < mipCount - 1; i++)
            mipBufferArray.push(buffer.slice(dataOffsets[i], dataOffsets[i + 1]));
        mipBufferArray.push(buffer.slice(dataOffsets[mipCount - 1], dataOffsets[0] + textureDataSize));
        mipBuffers = mipBufferArray;
    }

    return { name, imageDimension, imageFormat, width, height, depth, arraySize, mipBuffers, blockHeightLog2 };
}

export function parse(buffer: ArrayBufferSlice): BNTX {
    const view = buffer.createDataView();

    assert(readString(buffer, 0x00, 0x08, false) === 'BNTX\0\0\0\0');
    const littleEndian: boolean = isMarkerLittleEndian(view.getUint16(0x0C, false));

    const version = view.getUint32(0x08, littleEndian);
    const supportedVersions: number[] = [
        0x00040000, // Super Mario Odyssey
    ];
    assert(supportedVersions.includes(version));

    const targetPlatform = readString(buffer, 0x20, 0x04);
    assert(targetPlatform === 'NX  ');

    const textureDicOffs = view.getUint32(0x38, littleEndian);
    assert(readString(buffer, textureDicOffs + 0x00, 0x04) === '_DIC');

    const textureDicCount = view.getUint32(textureDicOffs + 0x04, littleEndian);
    let textureDicIdx = textureDicOffs + 0x18;
    let textureArrIdx = view.getUint32(0x28, littleEndian) + 0x00;
    const textures: BRTI[] = [];
    for (let i = 0; i < textureDicCount; i++) {
        const textureName = readBinStr(buffer, view.getUint32(textureDicIdx + 0x08, littleEndian), littleEndian);
        const textureHeaderOffs = view.getUint32(textureArrIdx + 0x00, littleEndian);

        const brti = parseBRTI(buffer, textureHeaderOffs, littleEndian);
        if (brti !== null) {
            assert(brti.name === textureName);
            textures.push(brti);
        }

        textureDicIdx += 0x10;
        textureArrIdx += 0x08;
    }

    return { textures };
}
