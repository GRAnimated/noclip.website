
import * as UI from '../ui.js';
import * as Viewer from '../viewer.js';

import { TextureHolder, TextureMapping } from '../TextureHolder.js';

import { GfxDevice, GfxSampler, GfxWrapMode, GfxMipFilterMode, GfxTexFilterMode, GfxCullMode, GfxCompareMode, GfxInputLayout, GfxBuffer, GfxBufferUsage, GfxFormat, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxBlendMode, GfxBlendFactor, GfxProgram, GfxMegaStateDescriptor, GfxIndexBufferDescriptor, GfxInputLayoutBufferDescriptor, makeTextureDescriptor2D, GfxBufferFrequencyHint, GfxChannelWriteMask, GfxTextureDimension, GfxTextureUsage, GfxSamplerFormatKind, GfxTexture } from '../gfx/platform/GfxPlatform.js';

import * as BNTX from '../fres_nx/bntx.js';
import { surfaceToCanvas } from '../Common/bc_texture.js';
import { translateImageFormat, deswizzle, decompress, getImageFormatString, getFormatBlockWidth, getFormatBlockHeight, getFormatBytesPerPixel } from '../fres_nx/tegra_texture.js';
import { FMDL, FSHP, FMAT, FMAT_RenderInfo, FMAT_RenderInfoType, FVTX, FSHP_Mesh, FRES, FVTX_VertexAttribute, FVTX_VertexBuffer, Texsrt, FMAT_ShaderParam, FSKL_Bone, FSKL_BoneRotationMode, parseFMAT_ShaderParam_Float, parseFMAT_ShaderParam_Float2, parseFMAT_ShaderParam_Float3, parseFMAT_ShaderParam_Float4, parseFMAT_ShaderParam_Color3, parseFMAT_ShaderParam_Texsrt } from '../fres_nx/bfres.js';
import { GfxRenderInst, makeSortKey, GfxRendererLayer, setSortKeyDepth, setSortKeyBias, getSortKeyLayer, GfxRenderInstManager, GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { TextureAddressMode, FilterMode, IndexFormat, AttributeFormat, getChannelFormat, getTypeFormat, ChannelFormat } from '../fres_nx/nngfx_enum.js';
import { nArray, assert, assertExists } from '../util.js';
import { fillMatrix4x4, fillMatrix4x3 } from '../gfx/helpers/UniformBufferHelpers.js';
import { mat3, mat4, quat, vec2, vec3, vec4 } from "gl-matrix";
import { CameraController, computeViewMatrix, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { AABB } from '../Geometry.js';
import { reverseDepthForCompareMode } from '../gfx/helpers/ReversedDepthHelpers.js';
import { DeviceProgram } from '../Program.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import { GfxrAttachmentSlot, GfxrRenderTargetDescription, GfxrRenderTargetID, GfxrTemporalTexture } from '../gfx/render/GfxRenderGraph.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { createBufferFromData, createBufferFromSlice } from '../gfx/helpers/BufferHelpers.js';
import { generateShaderUtil } from './Shaders/ShaderUtil.js';

const SMO_NEAR_CLIP = 100.0;
const SMO_FAR_CLIP = 1000000.0;
const SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE = 7000.0;
const SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE_SUB = 4000.0;
import { OdysseySceneDesc, GraphicsPreset, OdysseyRenderer } from './Scenes_SuperMarioOdyssey.js';
import { convertToCanvasData } from '../gfx/helpers/TextureConversionHelpers.js';
import { MathConstants, clamp } from '../MathHelpers.js';
import { bindingLayouts, OdysseyProgram } from './OdysseyProgram.js';
import { RenderMaterial } from './Shaders/RenderMaterial.js';
import { RenderSky } from './Shaders/RenderSky.js';
import { fillHdrComposeUniforms, HdrCompose } from './Shaders/HdrCompose.js';
import { RenderCloudLayer } from './Shaders/RenderCloudLayer.js';
import { LinearDepth } from './Shaders/LinearDepth.js';
import { fillRenderFogUniforms, RenderFog } from './Shaders/RenderFog.js';
import { composeLightMapCube, generateLightMapCube, generateLightMapSphere, GeneratedLightMapCube, GeneratedLightMapSphere } from './Render/LightMap.js';
import { InitRippleParam, findRippleMatParams } from './Render/Ripple.js';

const kLateBindingFramebuffer = 'smo-opaque-framebuffer';
const kLateBindingLinearDepth = 'smo-linear-depth';

function getBRTIMipLayerBuffer(mipBuffer: ArrayBufferSlice | ArrayBufferSlice[], layer = 0): ArrayBufferSlice {
    // BNTX array/cubemap textures store each mip as one buffer per array layer.
    // Plain 2D upload paths only want the first layer; cubemap paths request each face explicitly.
    return Array.isArray(mipBuffer) ? assertExists(mipBuffer[layer]) : mipBuffer;
}

export interface TextureScopeKey {
    archiveName?: string;
}

function makeScopeId(scope: TextureScopeKey): string {
    return scope.archiveName ?? '';
}

function makeDefaultGroupLabel(scope: TextureScopeKey): string {
    return scope.archiveName ?? 'Global';
}

function nextPow2(v: number): number {
    return v <= 1 ? 1 : 1 << Math.ceil(Math.log2(v));
}

function getBlockLinearMipLayerSize(width: number, height: number, channelFormat: ChannelFormat, blockHeightLog2: number): number {
    const blockWidth = getFormatBlockWidth(channelFormat);
    const blockHeightFormat = getFormatBlockHeight(channelFormat);
    const widthInBlocks = Math.ceil(width / blockWidth);
    const heightInBlocks = Math.ceil(height / blockHeightFormat);
    let blockHeight = 1 << blockHeightLog2;
    while (blockHeight > 1 && nextPow2(heightInBlocks) < 8 * blockHeight)
        blockHeight >>= 1;
    const bpp = getFormatBytesPerPixel(channelFormat);
    const widthInGobs = Math.ceil((widthInBlocks * bpp) / 64);
    const heightInGobBlocks = Math.ceil(heightInBlocks / (8 * blockHeight));
    return widthInGobs * 512 * blockHeight * heightInGobBlocks;
}

interface TextureEntry {
    gfxTexture: GfxTexture;
    viewerTexture: Viewer.Texture;
    name: string;
    scopeId: string;
}

class GroupedTextureHolder implements UI.TextureListHolder {
    public gfxTextures: GfxTexture[] = [];
    public viewerTextures: Viewer.Texture[] = [];
    public _textureNames: string[] = [];
    public onnewtextures: (() => void) | null = null;
    public pendingUploads: Promise<void>[] = [];
    private entries: TextureEntry[] = [];
    protected cubeCpuLevels = new Map<string, { size: number, levels: Float32Array[] }>();

    // scopeId to flat index
    private scopeIdToIndices = new Map<string, number[]>();

    // scopeId to label
    private scopeIdToLabel = new Map<string, string>();

    private scopeIds: string[] = [];

    public get textureNames(): string[] {
        return this._textureNames;
    }

    public async getViewerTexture(i: number) {
        return this.viewerTextures[i];
    }

    public fillTextureMapping(dst: TextureMapping, name: string): boolean {
        const textureEntryIndex = this.textureNames.indexOf(name);
        if (textureEntryIndex >= 0) {
            dst.gfxTexture = this.gfxTextures[textureEntryIndex];
            return true;
        }
        return false;
    }

    public fillScopedTextureMapping(dst: TextureMapping, name: string, scope: TextureScopeKey): boolean {
        const scopeId = this.ensureGroup(scope);
        const list = this.scopeIdToIndices.get(scopeId);
        if (!list)
            return false;

        for (const idx of list) {
            if (this.entries[idx].name === name) {
                dst.gfxTexture = this.entries[idx].gfxTexture;
                return true;
            }
        }
        return false;
    }

    private ensureGroup(scope: TextureScopeKey, customLabel?: string): string {
        const scopeId = makeScopeId(scope);
        if (!this.scopeIdToIndices.has(scopeId)) {
            this.scopeIdToIndices.set(scopeId, []);
            this.scopeIds.push(scopeId);
            const label = customLabel ?? makeDefaultGroupLabel(scope);
            this.scopeIdToLabel.set(scopeId, label);
        }
        return scopeId;
    }

    public hasTexture(name: string): boolean {
        return this.textureNames.indexOf(name) >= 0;
    }

    public getCubeTextureCpuLevels(name: string): { size: number, levels: Float32Array[] } | null {
        return this.cubeCpuLevels.get(name) ?? null;
    }

    public addTexture(gfxTexture: GfxTexture, viewerTexture: Viewer.Texture, scope: TextureScopeKey, groupLabel?: string): void {
        const scopeId = this.ensureGroup(scope, groupLabel);

        const index = this.entries.length;
        const entry: TextureEntry = {
            gfxTexture,
            viewerTexture,
            name: viewerTexture.name,
            scopeId,
        };
        this.entries.push(entry);
        this.gfxTextures.push(gfxTexture);
        this.viewerTextures.push(viewerTexture);
        this._textureNames.push(viewerTexture.name);

        this.scopeIdToIndices.get(scopeId)!.push(index);

        if (this.onnewtextures)
            this.onnewtextures();
    }

    public getGroupCount(): number {
        return this.scopeIds.length;
    }

    public getGroupName(i: number): string {
        const scopeId = this.scopeIds[i];
        return this.scopeIdToLabel.get(scopeId) ?? scopeId;
    }

    public getTextureIndicesForGroup(i: number): number[] {
        const scopeId = this.scopeIds[i];
        const indices = this.scopeIdToIndices.get(scopeId);
        return indices ? indices.slice() : [];
    }

    public destroy(device: GfxDevice): void {
        this.gfxTextures.forEach((texture) => device.destroyTexture(texture));
        this.gfxTextures = [];
        this.viewerTextures = [];
        this._textureNames = [];
        this.entries = [];
        this.scopeIdToIndices.clear();
        this.scopeIdToLabel.clear();
        this.scopeIds = [];
    }
}


export class BRTITextureHolder extends GroupedTextureHolder {
    public cubeMapSuffixName: string = '';

    public linearDepthTexture: GfxTexture;
    public framebufferTexture = new GfxrTemporalTexture();

    public createLinearDepthTexture(device: GfxDevice, width: number, height: number): void {
        if (this.linearDepthTexture) {
            device.destroyTexture(this.linearDepthTexture);
        }

        this.linearDepthTexture = device.createTexture({
            dimension: GfxTextureDimension.n2D,
            pixelFormat: GfxFormat.F32_RGBA,
            width,
            height,
            depthOrArrayLayers: 1,
            numLevels: 1,
            usage: GfxTextureUsage.Sampled | GfxTextureUsage.RenderTarget,
        });
    }

    public addFRESTextures(device: GfxDevice, fres: FRES, archiveName: string): void {
        const bntxFile = fres.externalFiles.find((f) => f.name === 'textures.bntx');
        if (bntxFile !== undefined) {
            const scope: TextureScopeKey = { archiveName: archiveName };
            this.addBNTXFile(device, bntxFile.buffer, scope);
        }
    }

    public addBNTXFile(device: GfxDevice, buffer: ArrayBufferSlice, scope: TextureScopeKey): void {
        const bntx = BNTX.parse(buffer);
        for (let i = 0; i < bntx.textures.length; i++) {
            const texName = bntx.textures[i].name;
            if (texName.startsWith("Default_") || texName.startsWith("SkyOnly_")) {
                this.addCubemapTexture(device, bntx.textures[i], scope);
            } else {
                this.addScopedTexture(device, bntx.textures[i], scope);
            }
        }
    }

    public addScopedTexture(device: GfxDevice, textureEntry: BNTX.BRTI, scope: TextureScopeKey): void {
        // some modded textures declare more levels than their dimensions support
        const maxDim = Math.max(textureEntry.width, textureEntry.height);
        const maxMips = maxDim > 0 ? Math.floor(Math.log2(maxDim)) + 1 : 1;
        const numLevels = Math.max(1, Math.min(textureEntry.mipBuffers.length, maxMips));

        let gfxTexture: GfxTexture;
        try {
            gfxTexture = device.createTexture(makeTextureDescriptor2D(translateImageFormat(textureEntry.imageFormat), textureEntry.width, textureEntry.height, numLevels));
        } catch (e) {
            console.error(`texture creation failed: ${textureEntry.name}:`, e);
            return;
        }
        const canvases: HTMLCanvasElement[] = [];

        const channelFormat = getChannelFormat(textureEntry.imageFormat);

        const uploadPromises: Promise<void>[] = [];

        for (let i = 0; i < numLevels; i++) {
            const mipLevel = i;

            const buffer = getBRTIMipLayerBuffer(textureEntry.mipBuffers[i]);
            const width = Math.max(textureEntry.width >>> mipLevel, 1);
            const height = Math.max(textureEntry.height >>> mipLevel, 1);
            const depth = 1;
            const blockHeightLog2 = textureEntry.blockHeightLog2;
            const p = deswizzle({ buffer, width, height, channelFormat, blockHeightLog2 }).then((deswizzled) => {
                const rgbaTexture = decompress({ ...textureEntry, width, height, depth }, deswizzled);
                let rgbaPixels = rgbaTexture.pixels;
                rgbaTexture.width = width;
                rgbaTexture.height = height;

                device.uploadTextureData(gfxTexture, mipLevel, [rgbaPixels]);

                const canvas = document.createElement('canvas');
                surfaceToCanvas(canvas, rgbaTexture);
                canvases.push(canvas);
            });
            uploadPromises.push(p);
        }

        this.pendingUploads.push(Promise.all(uploadPromises).then(() => {}));

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getImageFormatString(textureEntry.imageFormat));

        const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases, extraInfo };
        
        super.addTexture(gfxTexture, viewerTexture, scope);
    }

    public addCubemapTexture(device: GfxDevice, textureEntry: BNTX.BRTI, scope: TextureScopeKey): void {
        const numFaces = 6;
        const maxMips = Math.floor(Math.log2(Math.max(textureEntry.width, textureEntry.height))) + 1;
        const numMips = Math.min(textureEntry.mipBuffers.length, maxMips);
        const gfxTexture = device.createTexture({
            dimension: GfxTextureDimension.Cube,
            pixelFormat: translateImageFormat(textureEntry.imageFormat),
            width: textureEntry.width,
            height: textureEntry.height,
            depthOrArrayLayers: numFaces,
            numLevels: numMips,
            usage: GfxTextureUsage.Sampled
        });

        const canvases: HTMLCanvasElement[] = [];
        const channelFormat = getChannelFormat(textureEntry.imageFormat);

        const allLevelDatas: ArrayBufferView[] = [];
        const uploadPromises: Promise<void>[] = [];
        let processedMips = 0;

        for (let mipLevel = 0; mipLevel < numMips; mipLevel++) {
            const width = Math.max(textureEntry.width >>> mipLevel, 1);
            const height = Math.max(textureEntry.height >>> mipLevel, 1);
            const depth = 1;
            const blockHeightLog2 = textureEntry.blockHeightLog2;

            const levelDatas: ArrayBufferView[] = [];
            
            for (let faceIdx = 0; faceIdx < numFaces; faceIdx++) {
                const mipBuffer = textureEntry.mipBuffers[mipLevel];
                let buffer: ArrayBufferSlice;
                if (Array.isArray(mipBuffer)) {
                    buffer = getBRTIMipLayerBuffer(mipBuffer, faceIdx);
                } else {
                    const packed = getBRTIMipLayerBuffer(mipBuffer);
                    const layerSize = getBlockLinearMipLayerSize(width, height, channelFormat, blockHeightLog2);
                    buffer = packed.subarray(faceIdx * layerSize, layerSize);
                }
                
                const p = deswizzle({ buffer, width, height, channelFormat, blockHeightLog2 }).then((deswizzled) => {
                    const rgbaTexture = decompress({ ...textureEntry, width, height, depth }, deswizzled);
                    const rgbaPixels = rgbaTexture.pixels;
                    levelDatas[faceIdx] = rgbaPixels;
                    
                    if (levelDatas.length === numFaces && levelDatas.every(d => d !== undefined)) {
                        const bytesPerFace = rgbaPixels.byteLength;
                        const combinedBuffer = new Uint8Array(bytesPerFace * numFaces);
                        
                        for (let i = 0; i < numFaces; i++) {
                            combinedBuffer.set(new Uint8Array(levelDatas[i].buffer, levelDatas[i].byteOffset, levelDatas[i].byteLength), i * bytesPerFace);
                        }
                        
                        allLevelDatas[mipLevel] = combinedBuffer;
                        if (mipLevel === 0)
                            canvases[0] = this.makeCubemapContactSheet(`${textureEntry.name} uploaded faces`, textureEntry.width, combinedBuffer);
                        const normalized = new Float32Array(combinedBuffer.length);
                        for (let j = 0; j < combinedBuffer.length; j++)
                            normalized[j] = combinedBuffer[j] / 255.0;
                        const existing = this.cubeCpuLevels.get(textureEntry.name) ?? { size: textureEntry.width, levels: [] };
                        existing.levels[mipLevel] = normalized;
                        this.cubeCpuLevels.set(textureEntry.name, existing);
                        processedMips++;
                        
                        if (processedMips === numMips) {
                            device.uploadTextureData(gfxTexture, 0, allLevelDatas);
                        }
                    }
                    
                    if (mipLevel === 0) {
                        const canvas = document.createElement('canvas');
                        surfaceToCanvas(canvas, rgbaTexture);
                        canvas.title = `face ${faceIdx}`;
                        canvases[faceIdx + 1] = canvas;
                    }
                }).catch((e) => {
                    console.warn('smo cubemap face decode failed', {
                        textureName: textureEntry.name,
                        mipLevel,
                        faceIdx,
                        width,
                        height,
                        packed: !Array.isArray(mipBuffer),
                        error: e,
                    });
                });
                uploadPromises.push(p);
            }
        }

        this.pendingUploads.push(Promise.all(uploadPromises).then(() => {}));

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getImageFormatString(textureEntry.imageFormat));

        const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases, extraInfo };
        super.addTexture(gfxTexture, viewerTexture, scope);
    }

    private convertEncodedFloatTextureToU8(data: Float32Array): Uint8Array {
        const out = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++)
            out[i] = Math.round(clamp(data[i], 0, 1) * 255.0);
        return out;
    }

    private makeCubemapContactSheet(name: string, size: number, data: Uint8Array): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = size * 6;
        canvas.height = size;
        canvas.title = name;
        const ctx = assertExists(canvas.getContext('2d'));
        for (let face = 0; face < 6; face++) {
            const imageData = ctx.createImageData(size, size);
            const faceOffs = face * size * size * 4;
            imageData.data.set(data.subarray(faceOffs, faceOffs + size * size * 4));
            ctx.putImageData(imageData, face * size, 0);
        }
        return canvas;
    }

    public addGeneratedCubemapTexture(device: GfxDevice, generated: GeneratedLightMapCube, scope: TextureScopeKey, groupLabel = 'Generated Material Light'): void {
        if (this.fillTextureMapping(new TextureMapping(), generated.name))
            return;
        const gfxTexture = device.createTexture({
            dimension: GfxTextureDimension.Cube,
            // The light-map shader outputs HDR-encoded LDR texels. Store them as
            // normalized U8 so WebGL can bind them to normal filterable Float samplers.
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            width: generated.size,
            height: generated.size,
            depthOrArrayLayers: 6,
            numLevels: generated.numLevels,
            usage: GfxTextureUsage.Sampled,
        });
        const uploadLevels = generated.levels.map((level) => this.convertEncodedFloatTextureToU8(level));
        device.uploadTextureData(gfxTexture, 0, uploadLevels);
        this.cubeCpuLevels.set(generated.name, { size: generated.size, levels: generated.levels });
        const surfaces = [this.makeCubemapContactSheet(`${generated.name} faces`, generated.size, uploadLevels[0])];
        const viewerTexture: Viewer.Texture = { name: generated.name, surfaces, extraInfo: new Map([['Format', 'U8_RGBA_NORM encoded HDR cube'], ['Generated', 'alLightMap/alComposeLightMap CPU port'], ['Face order', '+X -X +Y -Y +Z -Z']]) };
        super.addTexture(gfxTexture, viewerTexture, scope, groupLabel);
    }

    public addGeneratedTexture2D(device: GfxDevice, generated: GeneratedLightMapSphere, scope: TextureScopeKey, groupLabel = 'Generated Material Light'): void {
        if (this.fillTextureMapping(new TextureMapping(), generated.name))
            return;
        const gfxTexture = device.createTexture({
            dimension: GfxTextureDimension.n2D,
            // Sphere material light is sampled raw in RenderMaterial_reference,
            // unlike the cube path. Keep HDR-ish values in a filterable float format.
            pixelFormat: GfxFormat.F16_RGBA,
            width: generated.width,
            height: generated.height,
            depthOrArrayLayers: 1,
            numLevels: 1,
            usage: GfxTextureUsage.Sampled,
        });
        device.uploadTextureData(gfxTexture, 0, [generated.data]);

        const canvas = document.createElement('canvas');
        canvas.width = generated.width;
        canvas.height = generated.height;
        const ctx = assertExists(canvas.getContext('2d'));
        const imageData = ctx.createImageData(generated.width, generated.height);
        for (let i = 0; i < generated.data.length; i += 4) {
            imageData.data[i + 0] = Math.round(clamp(generated.data[i + 0], 0, 1) * 255.0);
            imageData.data[i + 1] = Math.round(clamp(generated.data[i + 1], 0, 1) * 255.0);
            imageData.data[i + 2] = Math.round(clamp(generated.data[i + 2], 0, 1) * 255.0);
            imageData.data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);

        const viewerTexture: Viewer.Texture = { name: generated.name, surfaces: [canvas], extraInfo: new Map([['Format', 'F16_RGBA raw material sphere light'], ['Generated', 'alLightMap CPU port']]) };
        super.addTexture(gfxTexture, viewerTexture, scope, groupLabel);
    }

    public addLUTTexture(device: GfxDevice, width: number, color: { r: number; g: number; b: number; a: number }): void {
        const data = new Float32Array(width * 4);
        for (let i = 0; i < width; i++) {
            const o = i * 4;
            data[o + 0] = color.r;
            data[o + 1] = color.g;
            data[o + 2] = color.b;
            data[o + 3] = color.a;
        }

        const texture = device.createTexture({
            dimension: GfxTextureDimension.n2D,
            pixelFormat: GfxFormat.F32_RGBA,
            width: width,
            height: 1,
            depthOrArrayLayers: 1,
            numLevels: 1,
            usage: GfxTextureUsage.Sampled,
        });

        device.uploadTextureData(texture, 0, [data]);

        // draw the real canvas first
        const name = `LUT`;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const imageData = ctx.createImageData(width, 1);
            for (let i = 0; i < width; i++) {
                imageData.data[i * 4 + 0] = color.r;
                imageData.data[i * 4 + 1] = color.g;
                imageData.data[i * 4 + 2] = color.b;
                imageData.data[i * 4 + 3] = Math.round(color.a * 255);
            }
            ctx.putImageData(imageData, 0, 0);
            const debugData = ctx.getImageData(0, 0, 1, 1);
        } else {
            throw "whoops";
        }

        // and then upscale it so you can actually see it
        const upscaleWidth = 256;
        const upscaleHeight = 16;
        const upscaleCanvas = document.createElement('canvas');
        upscaleCanvas.width = upscaleWidth;
        upscaleCanvas.height = upscaleHeight;
        const upscaleCtx = upscaleCanvas.getContext('2d');
        if (upscaleCtx && ctx) {
            upscaleCtx.imageSmoothingEnabled = false;
            upscaleCtx.drawImage(canvas, 0, 0, width, 1, 0, 0, upscaleWidth, upscaleHeight);
        } else {
            throw "whoops";
        }
        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', 'F32_RGBA');
        const viewerTexture: Viewer.Texture = { name, surfaces: [upscaleCanvas], extraInfo };

        this.gfxTextures.push(texture);
        this.viewerTextures.push(viewerTexture);
        this.textureNames.push(name);
    }
}

function translateAddressMode(addrMode: TextureAddressMode): GfxWrapMode {
    switch (addrMode) {
    case TextureAddressMode.Repeat:
        return GfxWrapMode.Repeat;
    case TextureAddressMode.ClampToEdge:
    case TextureAddressMode.ClampToBorder:
        return GfxWrapMode.Clamp;
    case TextureAddressMode.Mirror:
        return GfxWrapMode.Mirror;
    case TextureAddressMode.MirrorClampToEdge:
        // TODO(jstpierre): This requires GL_ARB_texture_mirror_clamp_to_edge
        return GfxWrapMode.Mirror;
    default:
        throw "whoops";
    }
}

function translateMipFilterMode(filterMode: FilterMode): GfxMipFilterMode {
    switch (filterMode) {
    case FilterMode.Linear:
        return GfxMipFilterMode.Linear;
    case 0:
    case FilterMode.Point:
        return GfxMipFilterMode.Nearest;
    default:
        throw "whoops";
    }
}

function translateTexFilterMode(filterMode: FilterMode): GfxTexFilterMode {
    switch (filterMode) {
    case FilterMode.Linear:
        return GfxTexFilterMode.Bilinear;
    case FilterMode.Point:
        return GfxTexFilterMode.Point;
    default:
        throw "whoops";
    }
}

class MaterialParams {
    public const_color0 = vec4.create();
    public const_color1 = vec4.create();
    public const_color2 = vec4.create();
    public const_color3 = vec4.create();
    public const_single0 = 0.0;
    public const_single1 = 0.0;
    public const_single2 = 0.0;
    public const_single3 = 0.0;
    public base_color_mul_color = vec4.fromValues(1, 1, 1, 1);
    public uniform0_mul_color = vec4.fromValues(1, 1, 1, 1);
    public uniform1_mul_color = vec4.fromValues(1, 1, 1, 1);
    public uniform2_mul_color = vec4.fromValues(1, 1, 1, 1);
    public uniform3_mul_color = vec4.fromValues(1, 1, 1, 1);
    public uniform4_mul_color = vec4.fromValues(1, 1, 1, 1);
    public proc_texture_2d_mul_color = vec4.fromValues(1, 1, 1, 1);
    public proc_texture_3d_mul_color = vec4.fromValues(1, 1, 1, 1);
    public displacement1_color = vec4.fromValues(1, 1, 1, 1);
    public ripple_emission_color = vec4.fromValues(1, 1, 1, 1);
    public hack_color = vec4.fromValues(1, 1, 1, 1);
    public stain_color = vec4.fromValues(1, 1, 1, 1);
    public displacement_color = vec4.fromValues(1, 1, 1, 1);
    public Flow0_param = vec4.fromValues(1, 1, 1, 1);
    public tex_mtx0: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public tex_mtx1: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public tex_mtx2: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public tex_mtx3: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public mirror_view_proj = mat4.create();
    public sphere_rate_color0 = 1.0;
    public sphere_rate_color1 = 1.0;
    public sphere_rate_color2 = 1.0;
    public sphere_rate_color3 = 1.0;
    public decal_range = 0.0;
    public gbuf_fetch_offset = 0.0;
    public displacement_scale = 0.0;
    public displacement1_scale = 0.0;
    public stain_uv_scale = 0.0;
    public indirect_depth_scale = 0.0;
    public indirect0_scale: vec2 = vec2.create();
    public indirect1_scale: vec2 = vec2.create();
    public proc_texture_3d_scale = vec3.fromValues(1, 1, 1);
    public translucence_sharpness = 0.0;
    public translucence_sharpness_strength = 0.0;
    public translucence_factor = 0.0;
    public translucence_silhouette_stress = 0.0;
    public cloth_nov_peak_pos0 = 0.0;
    public cloth_nov_peak_pow0 = 0.0;
    public cloth_nov_peak_intensity0 = 0.0;
    public cloth_nov_tone_pow0 = 0.0;
    public cloth_nov_slope0 = 0.0;
    public cloth_nov_emission_scale0 = 0.0;
    public cloth_nov_noise_mask_scale0 = vec3.create();
    public force_roughness = 1.0;
    public material_lod_roughness = 1.0;
    public material_lod_metalness = 0.0;
    public alpha_test_value = 0.5;
    public wrap_coef = 0.0;
    public refract_thickness = 0.0;
    public stain_rate = 1.0;
}

class CloudMaterialParams {
    public uPhaseK: number = 0.0;
    public uPhaseKBack: number = 0.0;
    public uIsoRate: number = 0.0;
    public uDiffuseScatterRatePow: number = 0.0;
    public WrapCoef: vec2 = vec2.create();
    public cIndirectScale: vec2 = vec2.create();
    public albedo: vec4 = vec4.create();
    public cTexMtxAlbedo0:   Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public cTexMtxNormal0:   Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public cTexMtxIndirect0: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
    public cTexMtxIndirect1: Texsrt = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
}

class ModelAdditionalInfo {
    public model_alpha_mask = 1.0;
    public normal_axis_x_scale = 1.0;
    public uv_offset = vec2.create();
    public proj_mtx0 = mat4.create();
    public proj_mtx1 = mat4.create();
    public proj_mtx2 = mat4.create();
    public proj_mtx3 = mat4.create();
    public prog_constant0 = vec4.create();
    public prog_constant1 = vec4.create();
}

export function createProgramForMaterial(fmat: FMAT, initRippleParam: InitRippleParam | null = null): OdysseyProgram {
    if (fmat.shaderAssign.shaderArchiveName === 'alRenderSky') {
        return new RenderSky(fmat);
    } else if (fmat.shaderAssign.shaderArchiveName === 'alRenderCloudLayer') {
        return new RenderCloudLayer(fmat);
    } else {
        return new RenderMaterial(fmat, findRippleMatParams(initRippleParam, fmat.name).length > 0);
    }
}

function translateRenderInfoSingleString(renderInfo: FMAT_RenderInfo): string {
    assert(renderInfo.type === FMAT_RenderInfoType.String && renderInfo.values.length === 1);
    return renderInfo.values[0] as string;
}

function translateRenderInfoBoolean(renderInfo: FMAT_RenderInfo): boolean {
    const value = translateRenderInfoSingleString(renderInfo);
    if (value === 'true')
        return true;
    else if (value === 'false')
        return false;
    else
        throw "whoops";
}

function getRenderInfoSingleString(fmat: FMAT, name: string): string | null {
    const renderInfo = fmat.renderInfo.get(name);
    if (renderInfo === undefined || renderInfo.type !== FMAT_RenderInfoType.String || renderInfo.values.length < 1)
        return null;
    return renderInfo.values[0] as string;
}

function findMaterialLightCategoryName(fmat: FMAT, archiveName: string, materialLightCategoryMap?: Map<string, string> | null): string {
    const mappedCategory = materialLightCategoryMap?.get(fmat.name);
    if (mappedCategory !== undefined && mappedCategory !== '')
        return mappedCategory;
    const defaultCategory = materialLightCategoryMap?.get('Category');

    // executable shows that a "MaterialLightCategory" render-info key may exist
    const materialLightCategory = getRenderInfoSingleString(fmat, 'MaterialLightCategory');
    if (materialLightCategory !== null && materialLightCategory !== '' && materialLightCategory !== 'None')
        return materialLightCategory;

    return 'Default';
}

function getMaterialLightCategoryFromPreset(preset: any, categoryName: string): any | null {
    const categories = preset?.MaterialLight?.MaterialLightCategory;
    return categories.find((category: any) => category?.CategoryName === categoryName)
        ?? categories.find((category: any) => category?.CategoryName === 'Default')
        ?? categories[0]
        ?? null;
}

function findMaterialLightCategoryFromPreset(preset: any, categoryName: string): any | null {
    const categories = preset?.MaterialLight?.MaterialLightCategory;
    return categories.find((category: any) => category?.CategoryName === categoryName)
        ?? categories[0]
        ?? null;
}

function getMaterialLightMapName(category: any): string {
    const mapName = category?.MapName;
    return typeof mapName === 'string' ? mapName : '';
}

function resolveMaterialLightCubeMapName(preset: any, category: any): string {
    let mapName = getMaterialLightMapName(category);
    if (mapName !== '')
        return mapName;

    // al::MaterialLightDirector::getLightMapSampler() treats an empty cube
    // MapName as a reference to the "Default" material-light category,
    // while sphere material lights stay black when empty
    mapName = getMaterialLightMapName(findMaterialLightCategoryFromPreset(preset, 'Default'));
    return mapName;
}

function translateCullMode(fmat: FMAT): GfxCullMode {
    const display_face = translateRenderInfoSingleString(fmat.renderInfo.get('display_face')!);
    if (display_face === 'front')
        return GfxCullMode.Back;
    else if (display_face === 'back')
        return GfxCullMode.Front;
    else if (display_face === 'both')
        return GfxCullMode.None;
    else
        throw "whoops";
}

function translateDepthWrite(fmat: FMAT): boolean {
    return translateRenderInfoBoolean(fmat.renderInfo.get('enable_depth_write')!);
}

function translateDepthCompare(fmat: FMAT): GfxCompareMode {
    if (translateRenderInfoBoolean(fmat.renderInfo.get('enable_depth_test')!)) {
        const depth_test_func = translateRenderInfoSingleString(fmat.renderInfo.get('depth_test_func')!);
        if (depth_test_func === 'Lequal')
            return GfxCompareMode.LessEqual;
        else
            throw "whoops";
    } else {
        return GfxCompareMode.Always;
    }
}

function translateRenderInfoBlendFactor(renderInfo: FMAT_RenderInfo): GfxBlendFactor {
    const value = translateRenderInfoSingleString(renderInfo);
    if (value === 'src_alpha')
        return GfxBlendFactor.SrcAlpha;
    else if (value === 'one_minus_src_alpha')
        return GfxBlendFactor.OneMinusSrcAlpha;
    else if (value === 'one')
        return GfxBlendFactor.One;
    else if (value === 'zero')
        return GfxBlendFactor.Zero;
    else
        throw "whoops";
}

function translateBlendSrcFactor(fmat: FMAT): GfxBlendFactor {
    return translateRenderInfoBlendFactor(fmat.renderInfo.get('color_blend_rgb_src_func')!);
}

function translateBlendDstFactor(fmat: FMAT): GfxBlendFactor {
    return translateRenderInfoBlendFactor(fmat.renderInfo.get('color_blend_rgb_dst_func')!);
}

function translateBlendAlphaSrcFactor(fmat: FMAT): GfxBlendFactor {
    const info = fmat.renderInfo.get('color_blend_alpha_src_func');
    return info !== undefined ? translateRenderInfoBlendFactor(info) : translateBlendSrcFactor(fmat);
}

function translateBlendAlphaDstFactor(fmat: FMAT): GfxBlendFactor {
    const info = fmat.renderInfo.get('color_blend_alpha_dst_func');
    return info !== undefined ? translateRenderInfoBlendFactor(info) : translateBlendDstFactor(fmat);
}

function isAdditiveXlu(fmat: FMAT): boolean {
    const forward = getRenderInfoSingleString(fmat, 'forward_xlu') ?? '';
    const deferred = getRenderInfoSingleString(fmat, 'deferred_xlu') ?? '';
    return forward.includes('Add') || deferred.includes('Add');
}

function createDirectionalLightSampler(cache: GfxRenderCache): GfxSampler {
    return cache.createSampler({
        wrapS: GfxWrapMode.Clamp,
        wrapT: GfxWrapMode.Clamp,
        minFilter: GfxTexFilterMode.Bilinear,
        magFilter: GfxTexFilterMode.Bilinear,
        mipFilter: GfxMipFilterMode.Linear,
        minLOD: 0,
        maxLOD: 0,
    });
}

class FMATInstance {
    public gfxSamplers: GfxSampler[] = [];
    public textureMapping: TextureMapping[] = [];
    private program: OdysseyProgram;
    private gfxProgram: GfxProgram;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;
    private materialParams: MaterialParams | CloudMaterialParams = new MaterialParams();
    public modelAdditionalInfo = new ModelAdditionalInfo();

    constructor(device: GfxDevice, cache: GfxRenderCache, textureHolder: BRTITextureHolder, public fmat: FMAT, private archiveName: string, private materialLightCategoryMap: Map<string, string> | null = null, private initRippleParam: InitRippleParam | null = null) {
        this.program = createProgramForMaterial(fmat, initRippleParam);

        // Fill in our texture mappings.
        assert(fmat.samplerInfo.length === fmat.textureName.length);

        this.textureMapping = nArray(16, () => new TextureMapping());
        for (let i = 0; i < fmat.samplerInfo.length; i++) {
            const samplerInfo = fmat.samplerInfo[i];
            const gfxSampler = cache.createSampler({
                wrapS: translateAddressMode(samplerInfo.addrModeU),
                wrapT: translateAddressMode(samplerInfo.addrModeV),
                mipFilter: translateMipFilterMode((samplerInfo.filterMode >>> FilterMode.MipShift) & 0x03),
                minFilter: translateTexFilterMode((samplerInfo.filterMode >>> FilterMode.MinShift) & 0x03),
                magFilter: translateTexFilterMode((samplerInfo.filterMode >>> FilterMode.MagShift) & 0x03),
                maxLOD: samplerInfo.maxLOD,
                minLOD: samplerInfo.minLOD,
            });
            this.gfxSamplers.push(gfxSampler);

            if (i < 8) {
                const textureName = fmat.textureName[i];
                const scope: TextureScopeKey = {archiveName: this.archiveName};

                const foundScoped = textureHolder.fillScopedTextureMapping(this.textureMapping[i], textureName, scope);
                if (!foundScoped)
                    textureHolder.fillTextureMapping(this.textureMapping[i], textureName);

                this.textureMapping[i].gfxSampler = gfxSampler;
            }
        }

        for (const assignment of this.program.getMaterialSamplerSlotAssignments())
            this.fillMaterialSamplerBinding(textureHolder, assignment.textureUnit, assignment.samplerIndex);

        const cubemapTextureName = 'Default_' + textureHolder.cubeMapSuffixName;
        let cubemapSampler: GfxSampler | null = null;
        if (cubemapTextureName) {
            cubemapSampler = cache.createSampler({
                minFilter: GfxTexFilterMode.Bilinear,
                magFilter: GfxTexFilterMode.Bilinear,
                mipFilter: GfxMipFilterMode.Linear,
                minLOD: 0,
                maxLOD: 100,
                wrapS: GfxWrapMode.Clamp,
                wrapT: GfxWrapMode.Clamp,
            });
            this.gfxSamplers.push(cubemapSampler);

            textureHolder.fillTextureMapping(this.textureMapping[OdysseyProgram._m0], cubemapTextureName);
            this.textureMapping[OdysseyProgram._m0].gfxSampler = cubemapSampler;
        }

        const lutSampler = createDirectionalLightSampler(cache);
        this.gfxSamplers.push(lutSampler);

        textureHolder.fillTextureMapping(this.textureMapping[OdysseyProgram._lut0], "LUT");
        this.textureMapping[OdysseyProgram._lut0].gfxSampler = lutSampler;

        textureHolder.fillTextureMapping(this.textureMapping[OdysseyProgram._e0], "Exposure");
        this.textureMapping[OdysseyProgram._e0].gfxSampler = lutSampler;

        this.textureMapping[OdysseyProgram._ld0].gfxTexture = textureHolder.linearDepthTexture;
        this.textureMapping[OdysseyProgram._ld0].gfxSampler = lutSampler;
        this.textureMapping[OdysseyProgram._ld0].lateBinding = kLateBindingLinearDepth;

        this.textureMapping[OdysseyProgram._fb0].gfxTexture = textureHolder.framebufferTexture.getTextureForSampling();
        this.textureMapping[OdysseyProgram._fb0].gfxSampler = lutSampler;
        this.textureMapping[OdysseyProgram._fb0].lateBinding = kLateBindingFramebuffer;

        // WebGL limits us to 16 samplers so we don't have room for a second cubemap slot
        // If a material uses cTextureMaterialLightCube, we bind it to the first cubemap
        // slot instead of the roughness cubemap
        const enableMaterialLight = this.fmat.shaderAssign.shaderOption.get('enable_material_light') ?? this.fmat.shaderAssign.shaderOption.get('cIsEnableMaterialLight');
        let boundGeneratedMaterialLightSphere = false;
        if (enableMaterialLight === '1' || enableMaterialLight === 'true') {
            const presetAny = OdysseyRenderer.graphicsPreset as any;
            const materialLightCategoryName = findMaterialLightCategoryName(this.fmat, this.archiveName, this.materialLightCategoryMap);
            const selectedMaterialLightCategory = getMaterialLightCategoryFromPreset(presetAny, materialLightCategoryName);
            const materialLightMapName = resolveMaterialLightCubeMapName(presetAny, selectedMaterialLightCategory);
            const materialLightSphereMapName = selectedMaterialLightCategory?.SphereMapName;
            if (typeof materialLightMapName === 'string' && materialLightMapName.length > 0) {
                const lightMapParam = OdysseyRenderer.lightMapList.get(materialLightMapName);
                let boundTextureName = cubemapTextureName;
                if (lightMapParam !== undefined && lightMapParam.isEnable) {
                    const generatedTextureName = `MaterialLight:${materialLightMapName}`;
                    const composedTextureName = `MaterialLightCompose:${materialLightMapName}:${textureHolder.cubeMapSuffixName}`;
                    if (!textureHolder.hasTexture(composedTextureName)) {
                        const generated = generateLightMapCube(lightMapParam, generatedTextureName);
                        const areaCube = textureHolder.getCubeTextureCpuLevels(cubemapTextureName);
                        const composed = composeLightMapCube(generated, areaCube?.levels ?? null, areaCube?.size ?? generated.size, composedTextureName);
                        textureHolder.addGeneratedCubemapTexture(device, composed, { archiveName: this.archiveName });
                    }
                    boundTextureName = composedTextureName;
                }
                textureHolder.fillTextureMapping(this.textureMapping[OdysseyProgram._m0], boundTextureName);
                this.textureMapping[OdysseyProgram._m0].gfxSampler = cubemapSampler;

                if (typeof materialLightSphereMapName === 'string' && materialLightSphereMapName.length > 0) {
                    const sphereParam = OdysseyRenderer.lightMapList.get(materialLightSphereMapName) ?? lightMapParam;
                    if (sphereParam !== undefined && sphereParam.isEnable) {
                        const sphereName = `MaterialLightSphere:${materialLightSphereMapName}`;
                        if (!textureHolder.hasTexture(sphereName)) {
                            const sphere = generateLightMapSphere(sphereParam, sphereName);
                            textureHolder.addGeneratedTexture2D(device, sphere, { archiveName: this.archiveName });
                        }
                        textureHolder.fillTextureMapping(this.textureMapping[OdysseyProgram._mls0], sphereName);
                        this.textureMapping[OdysseyProgram._mls0].gfxSampler = cubemapSampler;
                        boundGeneratedMaterialLightSphere = true;
                    }
                }

            } else {
                this.fillSpecialSamplerBinding(textureHolder, OdysseyProgram._m0, 'cTextureMaterialLightCube');
            }
        }
        if (!boundGeneratedMaterialLightSphere)
            this.fillSpecialSamplerBinding(textureHolder, OdysseyProgram._mls0, 'cTextureMaterialLightSphere');
        this.fillSpecialSamplerBinding(textureHolder, OdysseyProgram._pt2d0, 'cTextureProcTexture2D');
        this.fillSpecialSamplerBinding(textureHolder, OdysseyProgram._pt3d0, 'cTextureProcTexture3D');

        this.gfxProgram = cache.createProgram(this.program);

        const isTranslucent = (this.program instanceof RenderMaterial) ? this.program.isTranslucent : false;

        if (fmat.shaderAssign.shaderArchiveName === 'alRenderSky') {
            this.megaStateFlags = {
                cullMode:       GfxCullMode.None,
                depthCompare:   GfxCompareMode.Always,
                depthWrite:     false,
            };
            setAttachmentStateSimple(this.megaStateFlags, {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.One,
                blendDstFactor: GfxBlendFactor.Zero,
            });
        } else if (fmat.shaderAssign.shaderArchiveName === 'alRenderCloudLayer') {
            this.megaStateFlags = {
                cullMode:       GfxCullMode.None,
                depthCompare:   GfxCompareMode.Greater,
                depthWrite:     false,
            };
            setAttachmentStateSimple(this.megaStateFlags, {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.SrcAlpha,
                blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
            });
            this.parseCloudMaterialParams(fmat);
        } else {
            const additiveXlu = isTranslucent && isAdditiveXlu(fmat);
            const rippleMatParams = findRippleMatParams(this.initRippleParam, fmat.name);
            const isRippleXlu = isTranslucent && rippleMatParams.length > 0;
            const enableTransparent = this.fmat.shaderAssign.shaderOption.get('enable_transparent') === '1';
            const enableXluZPrepass = getRenderInfoSingleString(fmat, 'enable_xlu_zprepass') === 'true';
            const depthWrite = isTranslucent
                ? (!additiveXlu && (enableTransparent || enableXluZPrepass) && translateDepthWrite(fmat))
                : translateDepthWrite(fmat);
            this.megaStateFlags = {
                cullMode:       translateCullMode(fmat),
                depthCompare:   reverseDepthForCompareMode(translateDepthCompare(fmat)),
                depthWrite,
            };
            const usePremultipliedAlphaBlend = this.program instanceof RenderMaterial && this.program.usePremultipliedAlphaBlend;
            setAttachmentStateSimple(this.megaStateFlags, {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: additiveXlu || usePremultipliedAlphaBlend ? GfxBlendFactor.One : (isRippleXlu ? GfxBlendFactor.SrcAlpha : (isTranslucent ? translateBlendSrcFactor(fmat) : GfxBlendFactor.One)),
                blendDstFactor: additiveXlu ? GfxBlendFactor.One : (isRippleXlu ? GfxBlendFactor.OneMinusSrcAlpha : (isTranslucent ? translateBlendDstFactor(fmat) : GfxBlendFactor.Zero)),
            });
            if (isTranslucent && this.megaStateFlags.attachmentsState !== undefined) {
                this.megaStateFlags.attachmentsState[0].alphaBlendState.blendSrcFactor = isRippleXlu ? GfxBlendFactor.SrcAlpha : translateBlendAlphaSrcFactor(fmat);
                this.megaStateFlags.attachmentsState[0].alphaBlendState.blendDstFactor = isRippleXlu ? GfxBlendFactor.OneMinusSrcAlpha : translateBlendAlphaDstFactor(fmat);
            }
            this.parseMaterialParams(fmat);
        }
    }

    private fillMaterialSamplerBinding(textureHolder: BRTITextureHolder, dstIndex: number, samplerIndex: number): void {
        const textureName = this.fmat.textureName[samplerIndex];
        const scope: TextureScopeKey = {archiveName: this.archiveName};
        const foundScoped = textureHolder.fillScopedTextureMapping(this.textureMapping[dstIndex], textureName, scope);
        if (!foundScoped)
            textureHolder.fillTextureMapping(this.textureMapping[dstIndex], textureName);

        this.textureMapping[dstIndex].gfxSampler = this.gfxSamplers[samplerIndex];
    }

    private fillSpecialSamplerBinding(textureHolder: BRTITextureHolder, dstIndex: number, shaderSamplerName: string): void {
        const samplerName = this.fmat.shaderAssign.samplerAssign.get(shaderSamplerName);
        if (samplerName === undefined)
            return;

        const samplerIndex = this.fmat.samplerInfo.findIndex((sampler) => sampler.name === samplerName);
        if (samplerIndex < 0)
            return;

        this.fillMaterialSamplerBinding(textureHolder, dstIndex, samplerIndex);
    }

    public setOnRenderInst(device: GfxDevice, renderInst: GfxRenderInst): void {
        const isTranslucent = (this.program instanceof RenderMaterial) ? this.program.isTranslucent : false;
        const materialLayer = isTranslucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        renderInst.sortKey = makeSortKey(materialLayer, 0);
        const drawPriority = this.fmat.renderInfo.get('draw_priority')?.values[0];
        if (isTranslucent && typeof drawPriority === 'number')
            renderInst.sortKey = setSortKeyBias(renderInst.sortKey, drawPriority);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setMegaStateFlags(this.megaStateFlags);
    }

    public destroy(device: GfxDevice): void {
        device.destroyProgram(this.gfxProgram);
    }

    private parseMaterialParams(fmat: FMAT): void {
        const params = fmat.shaderParam;
        const materialParams = new MaterialParams();
        const modelAdditionalInfo = new ModelAdditionalInfo();

        for (const p of params) {
            switch (p.name) {
                case 'const_single0':
                case 'const_single1':
                case 'const_single2':
                case 'const_single3':
                case 'sphere_rate_color0':
                case 'sphere_rate_color1':
                case 'sphere_rate_color2':
                case 'sphere_rate_color3':
                case 'decal_range':
                case 'gbuf_fetch_offset':
                case 'translucence_sharpness':
                case 'translucence_sharpness_strength':
                case 'translucence_factor':
                case 'translucence_silhouette_stress':
                case 'indirect_depth_scale':
                case 'cloth_nov_peak_pos0':
                case 'cloth_nov_peak_pow0':
                case 'cloth_nov_peak_intensity0':
                case 'cloth_nov_tone_pow0':
                case 'cloth_nov_slope0':
                case 'cloth_nov_emission_scale0':
                case 'displacement_scale':
                case 'displacement1_scale':
                case 'force_roughness':
                case 'stain_uv_scale':
                case 'wrap_coef':
                case 'refract_thickness':
                case 'stain_rate':
                case 'material_lod_roughness':
                case 'alpha_test_value':
                case 'material_lod_metalness':
                    materialParams[p.name] = parseFMAT_ShaderParam_Float(p);
                    break;

                case 'model_alpha_mask':
                case 'normal_axis_x_scale':
                    modelAdditionalInfo[p.name] = parseFMAT_ShaderParam_Float(p);
                    break;

                case 'indirect0_scale':
                case 'indirect1_scale':
                    if (!materialParams[p.name]) materialParams[p.name] = vec2.create();
                    parseFMAT_ShaderParam_Float2(materialParams[p.name], p);
                    break;

                case 'uv_offset':
                    parseFMAT_ShaderParam_Float2(modelAdditionalInfo.uv_offset, p);
                    break;

                case 'proc_texture_3d_scale':
                    if (!materialParams[p.name]) materialParams[p.name] = vec3.create();
                    parseFMAT_ShaderParam_Float3(materialParams[p.name], p);
                    break;

                case 'cloth_nov_noise_mask_scale0':
                    // Nintendo declares this as a vec3 but some materials provide an array.
                    // the shader only uses .y anyway so just expand
                    if (!materialParams[p.name]) materialParams[p.name] = vec3.create();
                    fillVec3FromFMATParam(materialParams[p.name], p);
                    break;

                case 'const_color0':
                case 'const_color1':
                case 'const_color2':
                case 'const_color3':
                case 'base_color_mul_color':
                case 'uniform0_mul_color':
                case 'uniform1_mul_color':
                case 'uniform2_mul_color':
                case 'uniform3_mul_color':
                case 'uniform4_mul_color':
                case 'proc_texture_2d_mul_color':
                case 'proc_texture_3d_mul_color':
                case 'displacement1_color':
                case 'ripple_emission_color':
                case 'hack_color':
                case 'stain_color':
                case 'displacement_color':
                case 'Flow0_param':
                    if (!materialParams[p.name]) materialParams[p.name] = vec4.create();
                    parseFMAT_ShaderParam_Float4(materialParams[p.name], p);
                    break;

                case 'prog_constant0':
                case 'prog_constant1':
                    parseFMAT_ShaderParam_Float4(modelAdditionalInfo[p.name], p);
                    break;

                case 'tex_mtx0':
                case 'tex_mtx1':
                case 'tex_mtx2':
                case 'tex_mtx3':
                    if (!materialParams[p.name]) materialParams[p.name] = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
                    parseFMAT_ShaderParam_Texsrt(materialParams[p.name], p);
                    break;

                case 'mirror_view_proj':
                    parseFMAT_ShaderParam_Float4x4(materialParams.mirror_view_proj, p);
                    break;

                case 'proj_mtx0':
                case 'proj_mtx1':
                case 'proj_mtx2':
                case 'proj_mtx3':
                    parseFMAT_ShaderParam_Float4x4(modelAdditionalInfo[p.name], p);
                    break;

                default:
                    // console.warn(`Unknown material parameter: ${p.name}`);
                    break;
            }
        }
        this.materialParams = materialParams;
        this.modelAdditionalInfo = modelAdditionalInfo;
    }

    private parseCloudMaterialParams(fmat: FMAT): void {
        const params = fmat.shaderParam;
        const materialParams = new CloudMaterialParams();

        for (const p of params) {
            switch (p.name) {
                case 'uPhaseK':
                case 'uPhaseKBack':
                case 'uIsoRate':
                case 'uDiffuseScatterRatePow':
                    materialParams[p.name] = parseFMAT_ShaderParam_Float(p);
                    break;

                case 'WrapCoef':
                case 'cIndirectScale':
                    if (!materialParams[p.name]) materialParams[p.name] = vec2.create();
                    parseFMAT_ShaderParam_Float2(materialParams[p.name], p);
                    break;

                case 'albedo':
                    if (!materialParams[p.name]) materialParams[p.name] = vec4.create();
                    parseFMAT_ShaderParam_Float4(materialParams[p.name], p);
                    break;

                case 'cTexMtxAlbedo0':
                case 'cTexMtxNormal0':
                case 'cTexMtxIndirect0':
                case 'cTexMtxIndirect1':
                    if (!materialParams[p.name]) materialParams[p.name] = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
                    parseFMAT_ShaderParam_Texsrt(materialParams[p.name], p);
                    break;

                default:
                    // console.warn(`Unknown material parameter: ${p.name}`);
                    break;
            }
        }

        // for CloudLayer:
        // WrapCoef.x = wrap_coef
        // WrapCoef.y = 1.0 / (wrap_coef + 1.0)
        // or else the background cloud layers don't have white wrapped lighting
        const wrapCoefInfo = fmat.renderInfo.get('wrap_coef');
        if (wrapCoefInfo !== undefined && wrapCoefInfo.type === FMAT_RenderInfoType.Float && wrapCoefInfo.values.length > 0) {
            const wrapCoef = wrapCoefInfo.values[0];
            materialParams.WrapCoef[0] = wrapCoef;
            materialParams.WrapCoef[1] = 1.0 / (wrapCoef + 1.0);
        }

        this.materialParams = materialParams;
    }

    public fillMaterialParams(d: Float32Array, offs: number): number {
        const materialParams = this.materialParams as MaterialParams;
        offs += fillVec4(d, offs, materialParams.const_color0);
        offs += fillVec4(d, offs, materialParams.const_color1);
        offs += fillVec4(d, offs, materialParams.const_color2);
        offs += fillVec4(d, offs, materialParams.const_color3);
        
        d[offs++] = materialParams.const_single0;
        d[offs++] = materialParams.const_single1;
        d[offs++] = materialParams.const_single2;
        d[offs++] = materialParams.const_single3;
        
        // mul colors
        offs += fillVec4(d, offs, materialParams.base_color_mul_color);
        offs += fillVec4(d, offs, materialParams.uniform0_mul_color);
        offs += fillVec4(d, offs, materialParams.uniform1_mul_color);
        offs += fillVec4(d, offs, materialParams.uniform2_mul_color);
        offs += fillVec4(d, offs, materialParams.uniform3_mul_color);
        offs += fillVec4(d, offs, materialParams.uniform4_mul_color);
        offs += fillVec4(d, offs, materialParams.proc_texture_2d_mul_color);
        offs += fillVec4(d, offs, materialParams.proc_texture_3d_mul_color);
        
        // texture matrices (mat2x4 = 2 vec4s)
        offs += fillTexsrtAsMatrix2x4(d, offs, materialParams.tex_mtx0);
        offs += fillTexsrtAsMatrix2x4(d, offs, materialParams.tex_mtx1);
        offs += fillTexsrtAsMatrix2x4(d, offs, materialParams.tex_mtx2);
        offs += fillTexsrtAsMatrix2x4(d, offs, materialParams.tex_mtx3);
        
        d[offs++] = materialParams.displacement_scale;
        d[offs++] = materialParams.displacement1_scale;
        offs += 2; // padding
        
        offs += fillVec4(d, offs, materialParams.displacement_color);
        offs += fillVec4(d, offs, materialParams.displacement1_color);
        
        d[offs++] = materialParams.wrap_coef;
        d[offs++] = materialParams.refract_thickness;

        // indirect0_scale
        d[offs++] = materialParams.indirect0_scale[0];
        d[offs++] = materialParams.indirect0_scale[1];
        
        // indirect1_scale (vec2)
        d[offs++] = materialParams.indirect1_scale[0];
        d[offs++] = materialParams.indirect1_scale[1];
        
        d[offs++] = materialParams.alpha_test_value;
        d[offs++] = materialParams.force_roughness;
        
        d[offs++] = materialParams.sphere_rate_color0;
        d[offs++] = materialParams.sphere_rate_color1;
        d[offs++] = materialParams.sphere_rate_color2;
        d[offs++] = materialParams.sphere_rate_color3;
        
        // mirror_view_proj
        for (let i = 0; i < 16; i++)
            d[offs++] = materialParams.mirror_view_proj[i];
        
        d[offs++] = materialParams.decal_range;
        d[offs++] = materialParams.gbuf_fetch_offset;
        d[offs++] = materialParams.translucence_sharpness;
        d[offs++] = materialParams.translucence_sharpness_strength;
        
        d[offs++] = materialParams.translucence_factor;
        d[offs++] = materialParams.translucence_silhouette_stress;
        d[offs++] = materialParams.indirect_depth_scale;
        d[offs++] = materialParams.cloth_nov_peak_pos0;
        d[offs++] = materialParams.cloth_nov_peak_pow0;
        d[offs++] = materialParams.cloth_nov_peak_intensity0;
        d[offs++] = materialParams.cloth_nov_tone_pow0;
        d[offs++] = materialParams.cloth_nov_slope0;
        
        d[offs++] = materialParams.cloth_nov_emission_scale0;
        offs += 3; // std140 padding before vec3 cloth_nov_noise_mask_scale0
        offs += fillVec3Padded(d, offs, materialParams.cloth_nov_noise_mask_scale0);
        
        // proc_texture_3d_scale (vec4, but vec3 in shader params)
        d[offs++] = materialParams.proc_texture_3d_scale[0];
        d[offs++] = materialParams.proc_texture_3d_scale[1];
        d[offs++] = materialParams.proc_texture_3d_scale[2];
        d[offs++] = 1.0;
        
        // flow0_param?
        
        offs += fillVec4(d, offs, materialParams.ripple_emission_color);
        offs += fillVec4(d, offs, materialParams.hack_color);
        offs += fillVec4(d, offs, materialParams.stain_color);
        
        d[offs++] = materialParams.stain_uv_scale;
        d[offs++] = materialParams.stain_rate;
        d[offs++] = materialParams.material_lod_roughness;
        d[offs++] = materialParams.material_lod_metalness;
        
        return offs;
    }

    public fillCloudMaterialParams(d: Float32Array, offs: number): number {
        const cloudMaterialParams = this.materialParams as CloudMaterialParams;
        d[offs++] = cloudMaterialParams.uPhaseK;
        d[offs++] = cloudMaterialParams.uPhaseKBack;
        d[offs++] = cloudMaterialParams.uIsoRate;
        d[offs++] = cloudMaterialParams.uDiffuseScatterRatePow;

        offs += fillVec2(d, offs, cloudMaterialParams.WrapCoef);
        offs += fillVec2(d, offs, cloudMaterialParams.cIndirectScale);
        offs += fillVec4(d, offs, cloudMaterialParams.albedo);

        // texture matrices (mat2x4 = 2 vec4s)
        offs += fillTexsrtAsMatrix2x4(d, offs, cloudMaterialParams.cTexMtxAlbedo0);
        offs += fillTexsrtAsMatrix2x4(d, offs, cloudMaterialParams.cTexMtxNormal0);
        offs += fillTexsrtAsMatrix2x4(d, offs, cloudMaterialParams.cTexMtxIndirect0);
        offs += fillTexsrtAsMatrix2x4(d, offs, cloudMaterialParams.cTexMtxIndirect1);

        return offs;
    }
}

function fillVec2(d: Float32Array, offs: number, v: vec2): number {
    d[offs++] = v[0];
    d[offs++] = v[1];
    return 2;
}

function fillVec4(d: Float32Array, offs: number, v: vec4): number {
    d[offs++] = v[0];
    d[offs++] = v[1];
    d[offs++] = v[2];
    d[offs++] = v[3];
    return 4;
}

function fillVec3Padded(d: Float32Array, offs: number, v: vec3): number {
    d[offs++] = v[0];
    d[offs++] = v[1];
    d[offs++] = v[2];
    d[offs++] = 0.0;
    return 4;
}

function fillVec3FromFMATParam(dst: vec3, p: FMAT_ShaderParam): void {
    if (p.rawData.byteLength === 4) {
        const view = p.rawData.createDataView();
        const v = view.getFloat32(0, p.littleEndian);
        dst[0] = 0.0;
        dst[1] = v;
        dst[2] = 0.0;
        return;
    }
    parseFMAT_ShaderParam_Float3(dst, p);
}

function parseFMAT_ShaderParam_Float4x4(dst: mat4, p: FMAT_ShaderParam): void {
    const view = p.rawData.createDataView();
    for (let i = 0; i < 16; i++)
        dst[i] = view.getFloat32(i * 4, p.littleEndian);
}

function fillModelAdditionalInfo(d: Float32Array, offs: number, info: ModelAdditionalInfo): number {
    const start = offs;

    d[offs++] = info.model_alpha_mask;
    d[offs++] = info.normal_axis_x_scale;
    d[offs++] = info.uv_offset[0];
    d[offs++] = info.uv_offset[1];

    for (let i = 0; i < 16; i++) d[offs++] = info.proj_mtx0[i];
    for (let i = 0; i < 16; i++) d[offs++] = info.proj_mtx1[i];
    for (let i = 0; i < 16; i++) d[offs++] = info.proj_mtx2[i];
    for (let i = 0; i < 16; i++) d[offs++] = info.proj_mtx3[i];

    offs += fillVec4(d, offs, info.prog_constant0);
    offs += fillVec4(d, offs, info.prog_constant1);

    return offs - start;
}

function fillTexsrtAsMatrix2x4(d: Float32Array, offs: number, texsrt: Texsrt): number {
    const theta = texsrt.rotation * MathConstants.DEG_TO_RAD;
    const sinR = Math.sin(theta);
    const cosR = Math.cos(theta);

    let m00: number, m01: number, m02: number;
    let m10: number, m11: number, m12: number;

    if (texsrt.mode === 1) { // Max
        m00 = texsrt.scaleS *  cosR;
        m01 = texsrt.scaleS *  sinR;
        m02 = texsrt.scaleS * ((-cosR * (texsrt.translationS + 0.5)) + (sinR * (texsrt.translationT - 0.5))) + 0.5;

        m10 = texsrt.scaleT * -sinR;
        m11 = texsrt.scaleT *  cosR;
        m12 = texsrt.scaleT * (( sinR * (texsrt.translationS + 0.5)) + (cosR * (texsrt.translationT - 0.5))) + 0.5;
    } else if (texsrt.mode === 2) { // XSI
        m00 = texsrt.scaleS *  cosR;
        m01 = texsrt.scaleS * -sinR;
        m02 = (texsrt.scaleS * sinR) - (texsrt.scaleS * cosR * texsrt.translationS) - (texsrt.scaleS * sinR * texsrt.translationT);

        m10 = texsrt.scaleT * sinR;
        m11 = texsrt.scaleT * cosR;
        m12 = (texsrt.scaleT * -cosR) - (texsrt.scaleT * sinR * texsrt.translationS) + (texsrt.scaleT * cosR * texsrt.translationT) + 1.0;
    } else { // Maya
        m00 = texsrt.scaleS * cosR;
        m01 = texsrt.scaleS * sinR;
        m02 = texsrt.scaleS * ((-0.5 * cosR) - (0.5 * sinR - 0.5) - texsrt.translationS);

        m10 = texsrt.scaleT * -sinR;
        m11 = texsrt.scaleT *  cosR;
        m12 = texsrt.scaleT * ((-0.5 * cosR) + (0.5 * sinR - 0.5) + texsrt.translationT) + 1.0;
    }

    d[offs++] = m00;
    d[offs++] = m10;
    d[offs++] = m02;
    d[offs++] = m01;
    d[offs++] = m11;
    d[offs++] = m12;
    d[offs++] = 0.0;
    d[offs++] = 0.0;

    return 8; // vec4 * 2
}

function translateAttributeFormat(attributeFormat: AttributeFormat): GfxFormat {
    switch (attributeFormat) {
    case AttributeFormat._8_8_Unorm:
        return GfxFormat.U8_RG_NORM;
    case AttributeFormat._8_8_Snorm:
        return GfxFormat.S8_RG_NORM;
    case AttributeFormat._8_8_Uint:
        return GfxFormat.U32_RG;
    case AttributeFormat._8_8_8_8_Unorm:
        return GfxFormat.U8_RGBA_NORM;
    case AttributeFormat._8_8_8_8_Snorm:
        return GfxFormat.S8_RGBA_NORM;
    case AttributeFormat._10_10_10_2_Snorm:
        // TODO(jstpierre): Get this right. We probably need to convert again like we did for Wii U.
        return GfxFormat.S8_RGBA_NORM;
    case AttributeFormat._16_16_Unorm:
        return GfxFormat.U16_RG_NORM;
    case AttributeFormat._16_16_Snorm:
        return GfxFormat.S16_RG_NORM;
    case AttributeFormat._16_16_Float:
        return GfxFormat.F16_RG;
    case AttributeFormat._16_16_16_16_Float:
        return GfxFormat.F16_RGBA;
    case AttributeFormat._32_32_Float:
        return GfxFormat.F32_RG;
    case AttributeFormat._32_32_32_Float:
        return GfxFormat.F32_RGB;
    case AttributeFormat._32_32_32_32_Float:
        return GfxFormat.F32_RGBA;
    default:
        console.warn('unhandled attribute format', getChannelFormat(attributeFormat), getTypeFormat(attributeFormat));
        return GfxFormat.F32_R; // fallback :(
    }
}

interface ConvertedVertexAttribute {
    format: GfxFormat;
    data: ArrayBufferLike;
    stride: number;
}

class FVTXData {
    public vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [];
    public inputBufferDescriptors: (GfxInputLayoutBufferDescriptor | null)[] = [];
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];

    constructor(device: GfxDevice, public fvtx: FVTX) {
        let nextBufferIndex = fvtx.vertexBuffers.length;

        for (let i = 0; i < fvtx.vertexAttributes.length; i++) {
            const vertexAttribute = fvtx.vertexAttributes[i];
            const bufferIndex = vertexAttribute.bufferIndex;

            if (this.inputBufferDescriptors[bufferIndex] === undefined)
                this.inputBufferDescriptors[bufferIndex] = null;

            const attribLocation = OdysseyProgram.a_Orders.indexOf(vertexAttribute.name);
            if (attribLocation < 0)
                continue;

            const vertexBuffer = fvtx.vertexBuffers[bufferIndex];
            const convertedAttribute = this.convertVertexAttribute(vertexAttribute, vertexBuffer);
            if (convertedAttribute !== null) {
                const attribBufferIndex = nextBufferIndex++;

                this.vertexAttributeDescriptors.push({
                    location: attribLocation,
                    format: convertedAttribute.format,
                    bufferIndex: attribBufferIndex,
                    // When we convert the buffer we remove the byte offset.
                    bufferByteOffset: 0,
                });

                this.inputBufferDescriptors[attribBufferIndex] = {
                    byteStride: convertedAttribute.stride,
                    frequency: GfxVertexBufferFrequency.PerVertex,
                };

                const gfxBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, convertedAttribute.data);
                this.vertexBufferDescriptors[attribBufferIndex] = { buffer: gfxBuffer };
            } else {
                // Can use buffer data directly.
                this.vertexAttributeDescriptors.push({
                    location: attribLocation,
                    format: translateAttributeFormat(vertexAttribute.format),
                    bufferIndex: bufferIndex,
                    bufferByteOffset: vertexAttribute.offset,
                });

                if (!this.vertexBufferDescriptors[bufferIndex]) {
                    const gfxBuffer = createBufferFromSlice(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexBuffer.data);

                    this.inputBufferDescriptors[bufferIndex] = {
                        byteStride: vertexBuffer.stride,
                        frequency: GfxVertexBufferFrequency.PerVertex,
                    };

                    this.vertexBufferDescriptors[bufferIndex] = { buffer: gfxBuffer };
                }
            }
        }
    }

    public convertVertexAttribute(vertexAttribute: FVTX_VertexAttribute, vertexBuffer: FVTX_VertexBuffer): ConvertedVertexAttribute | null {
        switch (vertexAttribute.format) {
        case AttributeFormat._10_10_10_2_Snorm:
            return this.convertVertexAttribute_10_10_10_2_Snorm(vertexAttribute, vertexBuffer);
        default:
            return null;
        }
    }

    public convertVertexAttribute_10_10_10_2_Snorm(vertexAttribute: FVTX_VertexAttribute, vertexBuffer: FVTX_VertexBuffer): ConvertedVertexAttribute {
        function signExtend10(n: number): number {
            return (n << 22) >> 22;
        }

        const numElements = vertexBuffer.data.byteLength / vertexBuffer.stride;
        const format = GfxFormat.S16_RGBA_NORM;
        const out = new Int16Array(numElements * 4);
        const stride = out.BYTES_PER_ELEMENT * 4;
        let dst = 0;
        let offs = vertexAttribute.offset;
        const view = vertexBuffer.data.createDataView();
        for (let i = 0; i < numElements; i++) {
            const n = view.getUint32(offs, true);
            out[dst++] = signExtend10((n >>>  0) & 0x3FF) << 4;
            out[dst++] = signExtend10((n >>> 10) & 0x3FF) << 4;
            out[dst++] = signExtend10((n >>> 20) & 0x3FF) << 4;
            out[dst++] = ((n >>> 30) & 0x03) << 14;
            offs += vertexBuffer.stride;
        }

        return { format, data: out.buffer, stride };
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.vertexBufferDescriptors.length; i++)
            if (this.vertexBufferDescriptors[i])
                device.destroyBuffer(this.vertexBufferDescriptors[i].buffer);
    }
}

export class FSHPMeshData {
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    public indexBufferDescriptor: GfxIndexBufferDescriptor;
    public inputLayout: GfxInputLayout;
    public indexBuffer: GfxBuffer;
    public indexStart: number;
    public boundingSphereCenter = vec3.create();
    public boundingSphereRadius = 0.0;

    constructor(cache: GfxRenderCache, public mesh: FSHP_Mesh, fvtxData: FVTXData) {
        const indexBufferFormat = translateIndexFormat(mesh.indexFormat);
        this.inputLayout = cache.createInputLayout({
            indexBufferFormat,
            vertexAttributeDescriptors: fvtxData.vertexAttributeDescriptors,
            vertexBufferDescriptors: fvtxData.inputBufferDescriptors,
        });
    
        this.vertexBufferDescriptors = fvtxData.vertexBufferDescriptors;
        const indexBufferData = translateIndexBufferFirstVertex(mesh.indexBufferData, mesh.indexFormat, mesh.offset);
        this.indexBuffer = createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexBufferData);
        this.indexBufferDescriptor = { buffer: this.indexBuffer };
        this.indexStart = 0;

        vec3.add(this.boundingSphereCenter, mesh.bbox.min, mesh.bbox.max);
        vec3.scale(this.boundingSphereCenter, this.boundingSphereCenter, 0.5);
        const ex = (mesh.bbox.max[0] - mesh.bbox.min[0]) * 0.5;
        const ey = (mesh.bbox.max[1] - mesh.bbox.min[1]) * 0.5;
        const ez = (mesh.bbox.max[2] - mesh.bbox.min[2]) * 0.5;
        this.boundingSphereRadius = Math.hypot(ex, ey, ez);
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.indexBuffer);
    }
}

export class FSHPData {
    public meshData: FSHPMeshData[] = [];

    constructor(cache: GfxRenderCache, public fshp: FSHP, fvtxData: FVTXData) {
        for (let i = 0; i < fshp.mesh.length; i++)
            this.meshData.push(new FSHPMeshData(cache, fshp.mesh[i], fvtxData));
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.meshData.length; i++)
            this.meshData[i].destroy(device);
    }
}

export interface GraphicsQualityParam {
    Name?: string;
    ParamType?: number;
    Rank?: number;
    GlobalMipBias?: number;
    StageGlobalMipBias?: number;
    IsForceStageGlobalMipBias?: boolean;
    LodDistanceScale?: number;
    IsEnableLod?: boolean;
}

export interface GpuPerfAreaParam {
    AreaName?: string;
    IsEnableLpp?: boolean;
    IsEnableOcclusionCulling?: boolean;
    LodDistanceScale?: number;
}

export class GraphicsQualityInfo {
    public globalMipBias = 0.0;
    public lodDistanceScale = 1.0;
    public isEnableLod = true;
    public isEnableOcclusionCulling = false;
    public isEnableLpp = true;

    private projectParam: GraphicsQualityParam | null = null;
    private stageParam: GraphicsQualityParam | null = null;
    private gpuPerfAreaParam: GpuPerfAreaParam | null = null;

    public applyProjectParam(param: GraphicsQualityParam): void {
        this.projectParam = param;
        this.recompute();
    }

    public applyStageParam(param: GraphicsQualityParam): void {
        this.stageParam = param;
        this.recompute();
    }

    public applyGpuPerfAreaParam(param: GpuPerfAreaParam | null): void {
        if (this.gpuPerfAreaParam === param)
            return;
        this.gpuPerfAreaParam = param;
        this.recompute();
    }

    private applyStageLikeParam(param: GraphicsQualityParam): void {
        this.lodDistanceScale = param.LodDistanceScale ?? this.lodDistanceScale;
        this.isEnableLod = param.IsEnableLod ?? this.isEnableLod;
        this.isEnableOcclusionCulling = (param as any).IsEnableOcclusionCulling ?? this.isEnableOcclusionCulling;
        this.isEnableLpp = (param as any).IsEnableLpp ?? this.isEnableLpp;
        if (param.IsForceStageGlobalMipBias)
            this.globalMipBias = param.StageGlobalMipBias ?? this.globalMipBias;
    }

    private recompute(): void {
        this.globalMipBias = 0.0;
        this.lodDistanceScale = 1.0;
        this.isEnableLod = true;
        this.isEnableOcclusionCulling = false;
        this.isEnableLpp = true;

        if (this.projectParam !== null) {
            this.applyStageLikeParam(this.projectParam);
            this.globalMipBias = this.projectParam.GlobalMipBias ?? this.globalMipBias;
        }

        if (this.stageParam !== null)
            this.applyStageLikeParam(this.stageParam);

        if (this.gpuPerfAreaParam !== null) {
            this.lodDistanceScale *= this.gpuPerfAreaParam.LodDistanceScale ?? 1.0;
            this.isEnableOcclusionCulling = this.gpuPerfAreaParam.IsEnableOcclusionCulling ?? this.isEnableOcclusionCulling;
            this.isEnableLpp = this.gpuPerfAreaParam.IsEnableLpp ?? this.isEnableLpp;
        }
    }
}

export interface InitLodParam {
    ModelLod?: number[];
    ShadowLod?: number[];
    MaterialLod?: number[];
    JudgeType?: number;
    IsSetShadowLod?: boolean;
    ShadowLodOffset?: number;
    IsEnableMaterialLod?: boolean;
}

function normalizeInitLodParam(parsed: any): InitLodParam | null {
    const root = (parsed?.root && typeof parsed.root === 'object') ? parsed.root : parsed;
    if (root === null || typeof root !== 'object')
        return null;
    return root as InitLodParam;
}

function readNumberArray(v: any): number[] | null {
    if (!Array.isArray(v))
        return null;
    return v.map((n) => typeof n === 'number' ? n : -1.0);
}

export class DistanceLevelParam {
    public distances: number[];
    public currentLevel = 0;
    public distanceScale = 1.0;

    constructor(count: number) {
        this.distances = nArray(count, () => -1.0);
    }

    public setParam(v: any): void {
        const distances = readNumberArray(v);
        if (distances === null)
            return;
        const n = Math.min(this.distances.length, distances.length);
        for (let i = 0; i < n; i++)
            this.distances[i] = distances[i];
    }

    public update(distance: number): void {
        let level = this.distances.length;
        for (let i = 0; i < this.distances.length; i++) {
            const threshold = this.distances[i] * this.distanceScale;
            if (threshold < 0.0 || threshold > distance) {
                level = i;
                break;
            }
        }
        this.currentLevel = level;
    }

    public getDistance(i: number): number {
        return this.distances[i] * this.distanceScale;
    }
}

const lodScratchAABB = new AABB();
function distancePointToAABB(point: vec3, aabb: AABB): number {
    let d2 = 0.0;
    for (let i = 0; i < 3; i++) {
        const v = point[i];
        let delta = 0.0;
        if (v < aabb.min[i])
            delta = aabb.min[i] - v;
        else if (v > aabb.max[i])
            delta = v - aabb.max[i];
        d2 += delta * delta;
    }
    return Math.sqrt(d2);
}

export class ModelLodCtrl {
    public modelLod: DistanceLevelParam;
    public shadowLod = new DistanceLevelParam(5);
    public materialLod = new DistanceLevelParam(1);
    public judgeType = 0;
    public isGlobalEnabled = true;
    public isValidate = true;
    public forcedLevel = -1;
    public shadowLodOffset = 0;
    public isSetShadowLod = true;
    public isEnableMaterialLodValue = false;

    constructor(public modelBBox: AABB, public lodModelCount: number) {
        this.modelLod = new DistanceLevelParam(Math.max(lodModelCount, 1));
    }

    public init(initLod: InitLodParam | null): void {
        if (initLod === null) {
            this.isValidate = false;
            return;
        }

        this.modelLod.setParam(initLod.ModelLod);
        this.shadowLod.setParam(initLod.ShadowLod);
        this.materialLod.setParam(initLod.MaterialLod);
        this.judgeType = initLod.JudgeType ?? this.judgeType;
        this.isSetShadowLod = initLod.IsSetShadowLod ?? this.isSetShadowLod;
        this.shadowLodOffset = Math.max(initLod.ShadowLodOffset ?? this.shadowLodOffset, 0);
        this.isEnableMaterialLodValue = initLod.IsEnableMaterialLod ?? this.isEnableMaterialLodValue;
    }

    public initFallback(): void {
        // TODO: this only contributes to some of the LOD in the game so 5000 is forced here until those are added
        const generated = nArray(this.lodModelCount, (i) => i < this.lodModelCount - 1 ? 5000.0 * Math.pow(3.0, i) : -1.0);
        this.modelLod.setParam(generated);
        this.shadowLod.setParam(nArray(5, () => -1.0));
        this.materialLod.setParam([-1.0]);
        this.judgeType = 1;
    }

    public isEnableMaterialLod(): boolean {
        return this.isEnableMaterialLodValue && this.isGlobalEnabled;
    }

    public setDistanceScale(v: number): void {
        this.modelLod.distanceScale = v;
        this.shadowLod.distanceScale = v;
        this.materialLod.distanceScale = v;
    }

    public update(viewerInput: Viewer.ViewerRenderInput, modelMatrix: mat4): void {
        if (!this.isValidate || !this.isGlobalEnabled)
            return;

        const cameraPos = vec3.fromValues(
            viewerInput.camera.worldMatrix[12],
            viewerInput.camera.worldMatrix[13],
            viewerInput.camera.worldMatrix[14],
        );
        let distance = 0.0;
        if (this.judgeType === 1) {
            lodScratchAABB.transform(this.modelBBox, modelMatrix);
            distance = distancePointToAABB(cameraPos, lodScratchAABB);
        } else if (this.judgeType === 0) {
            const dx = modelMatrix[12] - cameraPos[0];
            const dy = modelMatrix[13] - cameraPos[1];
            const dz = modelMatrix[14] - cameraPos[2];
            distance = Math.hypot(dx, dy, dz);
        }

        const fovyDegree = clamp(viewerInput.camera.fovY * MathConstants.RAD_TO_DEG, 1.0, 89.0);
        const adjustedDistance = distance * (Math.tan(fovyDegree * MathConstants.DEG_TO_RAD) / 0.8391);
        this.modelLod.update(adjustedDistance);
        this.shadowLod.update(adjustedDistance);
        this.materialLod.update(adjustedDistance);
    }

    public getModelLevel(): number {
        if (!this.isValidate || !this.isGlobalEnabled)
            return 0;
        const level = this.forcedLevel === -1 ? this.modelLod.currentLevel : this.forcedLevel;
        return Math.min(level, this.lodModelCount - 1);
    }

    public getModelLevelNoClamp(): number {
        if (!this.isValidate || !this.isGlobalEnabled)
            return 0;
        return this.forcedLevel === -1 ? this.modelLod.currentLevel : this.forcedLevel;
    }

    public getShadowLevel(): number {
        if (!this.isValidate || !this.isGlobalEnabled)
            return 0;
        const maxLevel = this.lodModelCount - 1;
        let level: number;
        if (this.isSetShadowLod)
            level = this.shadowLod.currentLevel;
        else
            level = this.getModelLevel();
        return Math.min(level + this.shadowLodOffset, maxLevel);
    }

    public getMaterialLevel(): number {
        if (!this.isEnableMaterialLod())
            return 0;
        return this.materialLod.currentLevel >= 1 ? 1 : this.materialLod.currentLevel;
    }
}

export class ModelLodAllCtrl {
    public isEnabled = true;
    public distanceScale = 1.0;
    private prevDistanceScale = 1.0;
    private needsUpdate = true;
    private ctrls: ModelLodCtrl[] = [];

    public registerLodCtrl(ctrl: ModelLodCtrl | null): void {
        if (ctrl !== null && this.ctrls.indexOf(ctrl) < 0) {
            this.ctrls.push(ctrl);
            this.needsUpdate = true;
        }
    }

    public update(viewerInput: Viewer.ViewerRenderInput, renderers: FMDLRenderer[], graphicsQualityInfo: GraphicsQualityInfo, debugModelLodDistanceScale: number = 1.0): void {
        this.isEnabled = graphicsQualityInfo.isEnableLod;
        this.distanceScale = graphicsQualityInfo.lodDistanceScale * debugModelLodDistanceScale;

        if (this.needsUpdate || this.prevDistanceScale !== this.distanceScale) {
            for (let i = 0; i < this.ctrls.length; i++) {
                this.ctrls[i].isGlobalEnabled = this.isEnabled;
                this.ctrls[i].setDistanceScale(this.distanceScale);
            }
            this.needsUpdate = false;
            this.prevDistanceScale = this.distanceScale;
        }

        for (let i = 0; i < renderers.length; i++)
            renderers[i].modelLodCtrl?.update(viewerInput, renderers[i].modelMatrix);
    }
}

const boneLocalScratch = mat4.create();
const boneQuatScratch = quat.create();

function calcBoneLocalMatrix(dst: mat4, bone: FSKL_Bone): void {
    if (bone.rotationMode === FSKL_BoneRotationMode.EulerXyz) {
        // BFRES stores Euler bones in radians while gl-matrix's helper takes degrees
        quat.fromEuler(boneQuatScratch,
            bone.rotation[0] * MathConstants.RAD_TO_DEG,
            bone.rotation[1] * MathConstants.RAD_TO_DEG,
            bone.rotation[2] * MathConstants.RAD_TO_DEG);
    } else {
        quat.set(boneQuatScratch, bone.rotation[0], bone.rotation[1], bone.rotation[2], bone.rotation[3]);
        quat.normalize(boneQuatScratch, boneQuatScratch);
    }

    mat4.fromRotationTranslationScale(dst, boneQuatScratch, bone.translation, bone.scale);
}

function calcBoneModelMatrices(bones: FSKL_Bone[]): mat4[] {
    const boneMatrices = nArray(bones.length, () => mat4.create());
    for (let i = 0; i < bones.length; i++) {
        const bone = bones[i];
        calcBoneLocalMatrix(boneLocalScratch, bone);
        if (bone.parentIndex >= 0 && bone.parentIndex < boneMatrices.length)
            mat4.mul(boneMatrices[i], boneMatrices[bone.parentIndex], boneLocalScratch);
        else
            mat4.copy(boneMatrices[i], boneLocalScratch);
    }
    return boneMatrices;
}

export class FMDLData {
    public fvtxData: FVTXData[] = [];
    public fshpData: FSHPData[] = [];
    public modelBBox = new AABB();
    public initLodParam: InitLodParam | null;
    public boneMatrices: mat4[];

    constructor(cache: GfxRenderCache, public fmdl: FMDL, public materialLightCategoryMap: Map<string, string> | null = null, public initRippleParam: InitRippleParam | null = null, initLodParam: any = null) {
        this.initLodParam = normalizeInitLodParam(initLodParam);
        this.boneMatrices = calcBoneModelMatrices(fmdl.fskl.bones);
        for (let i = 0; i < fmdl.fvtx.length; i++)
            this.fvtxData.push(new FVTXData(cache.device, fmdl.fvtx[i]));
        for (let i = 0; i < fmdl.fshp.length; i++) {
            const fshp = fmdl.fshp[i];
            const fshpData = new FSHPData(cache, fshp, this.fvtxData[fshp.vertexIndex]);
            this.fshpData.push(fshpData);
            if (fshpData.meshData.length > 0)
                this.modelBBox.union(this.modelBBox, fshpData.meshData[0].mesh.bbox);
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.fvtxData.length; i++)
            this.fvtxData[i].destroy(device);
        for (let i = 0; i < this.fshpData.length; i++)
            this.fshpData[i].destroy(device);
    }
}

function translateIndexBufferFirstVertex(indexBufferData: ArrayBufferSlice, indexFormat: IndexFormat, firstVertex: number): ArrayBuffer {
    const src = indexBufferData.createDataView();
    const dst = new ArrayBuffer(indexBufferData.byteLength);
    const view = new DataView(dst);

    if (indexFormat === IndexFormat.Uint8) {
        for (let i = 0; i < indexBufferData.byteLength; i++)
            view.setUint8(i, src.getUint8(i) + firstVertex);
    } else if (indexFormat === IndexFormat.Uint16) {
        for (let offs = 0; offs < indexBufferData.byteLength; offs += 2)
            view.setUint16(offs, src.getUint16(offs, true) + firstVertex, true);
    } else if (indexFormat === IndexFormat.Uint32) {
        for (let offs = 0; offs < indexBufferData.byteLength; offs += 4)
            view.setUint32(offs, src.getUint32(offs, true) + firstVertex, true);
    } else {
        throw "whoops";
    }

    return dst;
}

function translateIndexFormat(indexFormat: IndexFormat): GfxFormat {
    switch (indexFormat) {
    case IndexFormat.Uint8:  return GfxFormat.U8_R;
    case IndexFormat.Uint16: return GfxFormat.U16_R;
    case IndexFormat.Uint32: return GfxFormat.U32_R;
    default: throw "whoops";
    }
}

class FSHPMeshInstance {
    constructor(public meshData: FSHPMeshData) {
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        // TODO(jstpierre): Do we have to care about submeshes?
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.meshData.mesh.count, this.meshData.indexStart);
        renderInst.setVertexInput(this.meshData.inputLayout, this.meshData.vertexBufferDescriptors, this.meshData.indexBufferDescriptor);

        const depth = computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera.viewMatrix, this.meshData.mesh.bbox);
        renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, depth);
        renderInstManager.submitRenderInst(renderInst);
    }
}

// TODO: Move to Scenes
export function latLonToDirection(latitudeRad: number, longitudeRad: number): { x: number; y: number; z: number } {
    const latitudeX = -Math.cos(latitudeRad);
    
    return {
        x: Math.sin(longitudeRad) * latitudeX, // x
        y: -Math.sin(latitudeRad), // y
        z: Math.cos(longitudeRad) * latitudeX, // z
    };
}

const scratchMatrix = mat4.create();
const shapeModelMatrixScratch = mat4.create();
const sphereCenterScratch = vec3.create();

function getMatrixMaxScale(m: mat4): number {
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    return Math.max(sx, sy, sz);
}

export class SimpleModelEnv {
    private viewerInput: Viewer.ViewerRenderInput | null = null;
    private invExposure = 1.0;
    private globalLodBias = 0.0;

    public updateEnv(viewerInput: Viewer.ViewerRenderInput, invExposure: number, graphicsQualityInfo: GraphicsQualityInfo, debugGlobalLodBiasOffset: number = 0.0): void {
        this.viewerInput = viewerInput;
        this.invExposure = invExposure;
        this.globalLodBias = graphicsQualityInfo.globalMipBias + debugGlobalLodBiasOffset;
    }

    public fillMdlEnvView(d: Float32Array, offs: number): number {
        const viewerInput = assertExists(this.viewerInput);
        const preset = OdysseyRenderer.graphicsPreset!;
        
        d[offs++] = 4.0;     // HDRTranslate_uHDRPower
        d[offs++] = 1024.0;  // HDRTranslate_uDynamicRange
        offs += 2;          // padding

        const viewMatrix = scratchMatrix;
        computeViewMatrix(viewMatrix, viewerInput.camera);

        let dir: { x: number; y: number; z: number } = {x: 0, y: 0, z: 0};
        if (preset !== null)
            dir = latLonToDirection(preset.DirectionalLight.DirectionParam.Y, preset.DirectionalLight.DirectionParam.X);

        // DirectionParam gives LightDirFrom, then
        // GraphicsSystemInfo::tryDirectionalLightInfo negates it, then
        // SimpleModelEnv transforms it into view space before writing cDirLightViewDirFetchPos
        const lightDirWorld = vec3.fromValues(-dir.x, -dir.y, -dir.z);
        const lightDirView = vec3.create();
        vec3.transformMat3(lightDirView, lightDirWorld, mat3.fromMat4(mat3.create(), viewMatrix));
        vec3.normalize(lightDirView, lightDirView);

        // cDirLightViewDirFetchPos
        d[offs++] = lightDirView[0];
        d[offs++] = lightDirView[1];
        d[offs++] = lightDirView[2];
        d[offs++] = 1.0; // DirectionalLightKeeper::getTextureFetchPos()

        offs += fillMatrix4x3(d, offs, viewMatrix);
        
        const viewInv = mat4.create();
        mat4.invert(viewInv, viewMatrix);
        offs += fillMatrix4x3(d, offs, viewInv);
        
        const viewProj = mat4.create();
        mat4.mul(viewProj, viewerInput.camera.projectionMatrix, viewMatrix);
        offs += fillMatrix4x4(d, offs, viewProj);
        
        const viewProjInv = mat4.create();
        mat4.invert(viewProjInv, viewProj);
        offs += fillMatrix4x3(d, offs, viewProjInv);
        offs += 4;
        
        const projInv = mat4.create();
        mat4.invert(projInv, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(d, offs, projInv);
        
        // uInvProjViewNoTrans
        const invProjViewNoTrans = mat4.clone(viewProjInv);
        invProjViewNoTrans[12] = 0.0;  // remove translation
        invProjViewNoTrans[13] = 0.0;
        invProjViewNoTrans[14] = 0.0;
        offs += fillMatrix4x3(d, offs, invProjViewNoTrans);
        
        // cInvExposure and uIrradianceScale
        d[offs++] = this.invExposure;
        d[offs++] = 1.0;  // uIrradianceScale
        offs += 2;
        
        const near = viewerInput.camera.near;
        const far = viewerInput.camera.far;
        const range = far - near;
        d[offs++] = near;
        d[offs++] = far;
        d[offs++] = range;
        d[offs++] = 1.0 / range;
        
        // cTanFovyHalf (vec2)
        d[offs++] = viewerInput.camera.right / near;
        d[offs++] = viewerInput.camera.top / near;
        // cScrProjOffset (vec2)
        d[offs++] = 0.0;
        d[offs++] = 0.0;
        
        // cScrSize (vec4)
        d[offs++] = viewerInput.backbufferWidth;
        d[offs++] = viewerInput.backbufferHeight;
        d[offs++] = 1.0 / viewerInput.backbufferWidth;
        d[offs++] = 1.0 / viewerInput.backbufferHeight;
        
        // cCameraPos (vec3 + 1 padding)
        d[offs++] = viewerInput.camera.worldMatrix[12];
        d[offs++] = viewerInput.camera.worldMatrix[13];
        d[offs++] = viewerInput.camera.worldMatrix[14];
        offs += 1; // padding

        // cGlobalLodBias
        d[offs++] = this.globalLodBias;
        offs += 3; // padding

        let fog: any = { Color: { R: 0, G: 0, B: 0 }, IsEnable: false, Slope: 0, Start: 0, Max: 1, IsDeferredFog: false };
        let yFog: any = { Color: { R: 0, G: 0, B: 0 }, IsEnable: false, Slope: 0, Start: 0, Max: 1, IsDeferredFog: false };
        if (preset !== null) {
            fog = preset.Fog;
            yFog = preset.YFog;
        }

        // Fog parameters
        // cFogColor
        d[offs++] = fog.Color.R / 255.0;
        d[offs++] = fog.Color.G / 255.0;
        d[offs++] = fog.Color.B / 255.0;
        d[offs++] = fog.IsEnable ? fog.Slope / 1000.0 : 0.0;

        d[offs++] = fog.Start;
        d[offs++] = fog.Max;
        offs += 2; // padding

        // cYFogColor
        d[offs++] = yFog.Color.R / 255.0;
        d[offs++] = yFog.Color.G / 255.0;
        d[offs++] = yFog.Color.B / 255.0;
        d[offs++] = yFog.IsEnable ? yFog.Slope / 1000.0 : 0.0;
        
        d[offs++] = yFog.Start;
        d[offs++] = yFog.Max;
        
        // cViewAxisY
        const worldUp = vec3.fromValues(0.0, 1.0, 0.0);
        const viewAxisY = vec3.create();
        vec3.transformMat3(viewAxisY, worldUp, mat3.fromMat4(mat3.create(), viewMatrix));
        d[offs++] = viewAxisY[0];
        d[offs++] = viewAxisY[1];
        d[offs++] = viewAxisY[2];
        d[offs++] = 0.0;
        
        // cViewAxisZ
        const worldForward = vec3.fromValues(0.0, 0.0, 1.0);
        const viewAxisZ = vec3.create();
        vec3.transformMat3(viewAxisZ, worldForward, mat3.fromMat4(mat3.create(), viewMatrix));
        d[offs++] = viewAxisZ[0];
        d[offs++] = viewAxisZ[1];
        d[offs++] = viewAxisZ[2];
        d[offs++] = (fog.IsDeferredFog || yFog.IsDeferredFog) ? 1.0 : 0.0;
        
        return offs;
    }
}

class FSHPInstance {
    public lodMeshInstances: FSHPMeshInstance[] = [];
    public visible = true;
    public enableCulling = true;

    constructor(public fshpData: FSHPData, private fmatInstance: FMATInstance, private boneMatrix: mat4 | null = null) {
        for (let i = 0; i < fshpData.meshData.length; i++)
            this.lodMeshInstances.push(new FSHPMeshInstance(fshpData.meshData[i]));
    }

    public computeModelView(modelMatrix: mat4, viewerInput: Viewer.ViewerRenderInput): mat4 {
        // Build view matrix
        const viewMatrix = scratchMatrix;
        computeViewMatrix(viewMatrix, viewerInput.camera);
        mat4.mul(viewMatrix, viewMatrix, modelMatrix);
        return viewMatrix;
    }


    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, modelMatrix: mat4, viewerInput: Viewer.ViewerRenderInput, simpleModelEnv: SimpleModelEnv, modelLodLevel: number): void {
        if (!this.visible)
            return;

        const lodMeshInstance = this.lodMeshInstances[Math.min(modelLodLevel, this.lodMeshInstances.length - 1)];
        const shapeModelMatrix = this.boneMatrix !== null ? mat4.mul(shapeModelMatrixScratch, modelMatrix, this.boneMatrix) : modelMatrix;
        if (this.enableCulling) {
            vec3.transformMat4(sphereCenterScratch, lodMeshInstance.meshData.boundingSphereCenter, shapeModelMatrix);
            const radius = lodMeshInstance.meshData.boundingSphereRadius * getMatrixMaxScale(shapeModelMatrix);
            if (!viewerInput.camera.frustum.containsSphere(sphereCenterScratch, radius))
                return;
        }

        const template = renderInstManager.pushTemplate();

        // ub_ShapeParams
        let offs = template.allocateUniformBuffer(OdysseyProgram.ub_ShapeParams, 16+12+12);
        const d = template.mapUniformBufferF32(OdysseyProgram.ub_ShapeParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x3(d, offs, viewerInput.camera.viewMatrix);
        offs += fillMatrix4x3(d, offs, shapeModelMatrix);

        // ub_MdlEnvView has camera, environment, HDRTranslate, cGlobalLodBias, and fog data.
        const mdlEnvOffs = template.allocateUniformBuffer(OdysseyProgram.ub_MdlEnvView, 152);
        const envData = template.mapUniformBufferF32(OdysseyProgram.ub_MdlEnvView);
        simpleModelEnv.fillMdlEnvView(envData, mdlEnvOffs);
         
        // ub_CloudMaterial
        if (this.fmatInstance.fmat.shaderAssign.shaderArchiveName === 'alRenderCloudLayer') {
            const matOffs = template.allocateUniformBuffer(OdysseyProgram.ub_Material, 44);
            const matData = template.mapUniformBufferF32(OdysseyProgram.ub_Material);
            this.fmatInstance.fillCloudMaterialParams(matData, matOffs);
        } else { // ub_Material
            const matOffs = template.allocateUniformBuffer(OdysseyProgram.ub_Material, 164);
            const matData = template.mapUniformBufferF32(OdysseyProgram.ub_Material);
            this.fmatInstance.fillMaterialParams(matData, matOffs);
        }
 
        // ub_ModelAdditionalInfo
        const modelAddOffs = template.allocateUniformBuffer(OdysseyProgram.ub_ModelAdditionalInfo, 76);
        const modelAddData = template.mapUniformBufferF32(OdysseyProgram.ub_ModelAdditionalInfo);
        fillModelAdditionalInfo(modelAddData, modelAddOffs, this.fmatInstance.modelAdditionalInfo);
        
        this.fmatInstance.setOnRenderInst(device, template);

        lodMeshInstance.prepareToRender(device, renderInstManager, viewerInput);

        renderInstManager.popTemplate();
    }
}

export class FMDLRenderer {
    public fmatInst: FMATInstance[] = [];
    public fshpInst: FSHPInstance[] = [];
    public modelMatrix = mat4.create();
    public visible = true;
    public name: string;
    public modelLodCtrl: ModelLodCtrl | null = null;

    constructor(device: GfxDevice, cache: GfxRenderCache, public textureHolder: BRTITextureHolder, public fmdlData: FMDLData, archiveName: string) {
        const fmdl = this.fmdlData.fmdl;
        this.name = fmdl.name;
        const lodModelCount = Math.max(1, ...this.fmdlData.fshpData.map((fshpData) => fshpData.meshData.length));
        if (this.fmdlData.initLodParam !== null || lodModelCount > 1) {
            this.modelLodCtrl = new ModelLodCtrl(this.fmdlData.modelBBox, lodModelCount);
            if (this.fmdlData.initLodParam !== null)
                this.modelLodCtrl.init(this.fmdlData.initLodParam);
            else
                this.modelLodCtrl.initFallback();
        }

        for (let i = 0; i < fmdl.fmat.length; i++)
            this.fmatInst.push(new FMATInstance(device, cache, this.textureHolder, fmdl.fmat[i], archiveName, this.fmdlData.materialLightCategoryMap, this.fmdlData.initRippleParam));

        for (let i = 0; i < this.fmdlData.fshpData.length; i++) {
            const fshpData = this.fmdlData.fshpData[i];
            const fmatInstance = this.fmatInst[fshpData.fshp.materialIndex];
            const boneMatrix = this.fmdlData.boneMatrices[fshpData.fshp.boneIndex] ?? null;
            this.fshpInst.push(new FSHPInstance(fshpData, fmatInstance, boneMatrix));
        }
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, simpleModelEnv: SimpleModelEnv): void {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplate();
        template.setBindingLayouts(bindingLayouts);

        const modelLodLevel = this.modelLodCtrl !== null ? this.modelLodCtrl.getModelLevel() : 0;
        for (let i = 0; i < this.fshpInst.length; i++)
            this.fshpInst[i].prepareToRender(device, renderInstManager, this.modelMatrix, viewerInput, simpleModelEnv, modelLodLevel);

        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.fmatInst.length; i++)
            this.fmatInst[i].destroy(device);
    }
}

export class SkyRenderer extends FMDLRenderer {
    constructor(device: GfxDevice, cache: GfxRenderCache, textureHolder: BRTITextureHolder, fmdlData: FMDLData, archiveName: string) {
        super(device, cache, textureHolder, fmdlData, archiveName);

        for (let i = 0; i < this.fshpInst.length; i++) {
            this.fshpInst[i].enableCulling = false;

            // HACK: Additional objects in the sky model get culled out after rotation, this bypasses it
            const meshData = this.fshpInst[i].lodMeshInstances[0].meshData;
            meshData.mesh.bbox.min[0] = -1000000;
            meshData.mesh.bbox.min[1] = -1000000;
            meshData.mesh.bbox.min[2] = -1000000;
            meshData.mesh.bbox.max[0] = 1000000;
            meshData.mesh.bbox.max[1] = 1000000;
            meshData.mesh.bbox.max[2] = 1000000;
        }
    }

    public override prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, simpleModelEnv: SimpleModelEnv): void {
        if (!this.visible)
            return;

        // mat4.identity(this.modelMatrix);

        const template = renderInstManager.pushTemplate();
        template.setBindingLayouts(bindingLayouts);

        for (let i = 0; i < this.fshpInst.length; i++) {
            this.fshpInst[i].prepareToRender(device, renderInstManager, this.modelMatrix, viewerInput, simpleModelEnv, 0);
        }

        renderInstManager.popTemplate();
    }
}

export interface GraphicsRenderInfo {
    device: GfxDevice;
    viewerInput: Viewer.ViewerRenderInput;
    renderInstManager: GfxRenderInstManager;
    viewIndex: number;
}

class StageAreaVolumeBase {
    private worldToArea = mat4.create();

    constructor(placement: mat4, translate: vec3, rotateDeg: vec3, public scale: vec3, public priority: number = 0) {
        const areaToWorld = mat4.clone(placement);
        mat4.translate(areaToWorld, areaToWorld, translate);
        mat4.rotateZ(areaToWorld, areaToWorld, rotateDeg[2] * MathConstants.DEG_TO_RAD);
        mat4.rotateY(areaToWorld, areaToWorld, rotateDeg[1] * MathConstants.DEG_TO_RAD);
        mat4.rotateX(areaToWorld, areaToWorld, rotateDeg[0] * MathConstants.DEG_TO_RAD);
        mat4.invert(this.worldToArea, areaToWorld);
    }

    public containsWorldPoint(p: vec3): boolean {
        const local = vec3.transformMat4(vec3.create(), p, this.worldToArea);
        return Math.abs(local[0]) <= this.scale[0] * 500.0 &&
            Math.abs(local[1]) <= this.scale[1] * 500.0 &&
            Math.abs(local[2]) <= this.scale[2] * 500.0;
    }
}

export class GpuPerfAreaVolume extends StageAreaVolumeBase {
    constructor(public param: GpuPerfAreaParam, placement: mat4, translate: vec3, rotateDeg: vec3, scale: vec3, priority: number = 0) {
        super(placement, translate, rotateDeg, scale, priority);
    }
}

export class ClippingFarAreaVolume extends StageAreaVolumeBase {
    constructor(
        public farClipDistance: number,
        public farClipDistanceSub: number,
        placement: mat4,
        translate: vec3,
        rotateDeg: vec3,
        scale: vec3,
        priority: number = 0,
    ) {
        super(placement, translate, rotateDeg, scale, priority);
    }
}

export class RenderVariables {
    constructor(
        public builder: any,
        public hdrColorTargetID: GfxrRenderTargetID,
        public mainDepthTargetID: GfxrRenderTargetID,
        public opaqueColorResolveTextureID: any | null = null,
        public linearDepthTargetID: GfxrRenderTargetID | null = null,
        public linearDepthResolveTextureID: any | null = null,
    ) {
    }
}

export class ViewRenderer {
    public renderHelper: GfxRenderHelper;
    private renderInstListSky = new GfxRenderInstList();
    private renderInstListMain = new GfxRenderInstList();
    private renderInstListTranslucent = new GfxRenderInstList();
    public fmdlRenderers: FMDLRenderer[] = [];
    public skyRenderers: SkyRenderer[] = [];
    private simpleModelEnv = new SimpleModelEnv();
    private modelLodAllCtrl = new ModelLodAllCtrl();
    public graphicsQualityInfo = new GraphicsQualityInfo();
    public gpuPerfAreaVolumes: GpuPerfAreaVolume[] = [];
    public clippingFarAreaVolumes: ClippingFarAreaVolume[] = [];
    private clippingFarAreaDistance = SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE;
    private clippingFarAreaDistanceSub = SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE_SUB;

    private hdrComposeProgram: HdrCompose;
    private hdrComposeGfxProgram: GfxProgram;
    private linearDepthProgram: LinearDepth;
    private linearDepthGfxProgram: GfxProgram;
    private renderFogProgram: RenderFog;
    private renderFogGfxProgram: GfxProgram;
    private hdrTexture: GfxTexture | null = null;
    private exposureTexture: GfxTexture | null = null;
    private fullscreenVertexBuffer: GfxBuffer | null = null;
    private fullscreenIndexBuffer: GfxBuffer | null = null;
    private fullscreenInputLayout: GfxInputLayout | null = null;

    private exposureSlider: UI.Slider;
    private lodBiasSlider: UI.Slider;
    private modelLodDistanceScaleSlider: UI.Slider;

    private exposure: number = 1.0;
    private debugGlobalLodBiasOffset: number = 0.0;
    private debugModelLodDistanceScale: number = 1.0;
    private autoExposure: number = 1.0;
    private exposureTextureData = new Float32Array(4);

    private device: GfxDevice;

    constructor(device: GfxDevice, public textureHolder: BRTITextureHolder) {
        this.device = device;
        this.renderHelper = new GfxRenderHelper(device);

        this.hdrComposeProgram = new HdrCompose();
        this.hdrComposeGfxProgram = this.renderHelper.renderCache.createProgram(this.hdrComposeProgram);

        this.linearDepthProgram = new LinearDepth();
        this.linearDepthGfxProgram = this.renderHelper.renderCache.createProgram(this.linearDepthProgram);

        this.renderFogProgram = new RenderFog();
        this.renderFogGfxProgram = this.renderHelper.renderCache.createProgram(this.renderFogProgram);

        this.textureHolder.createLinearDepthTexture(device, 1, 1);
        
        this.createFullscreenQuad(device);
        this.createExposureTexture(device, textureHolder);
    }

    private createFullscreenQuad(device: GfxDevice): void {
        const vertices = new Float32Array([
            -1, -1, 0, 0,
            1, -1, 1, 0,
            -1, 1, 0, 1,
            1, 1, 1, 1,
        ]);
        
        const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
        
        this.fullscreenVertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertices.buffer);
        this.fullscreenIndexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indices.buffer);
        
        this.fullscreenInputLayout = this.renderHelper.renderCache.createInputLayout({
            indexBufferFormat: GfxFormat.U16_R,
            vertexAttributeDescriptors: [
                { location: 0, format: GfxFormat.F32_RG, bufferIndex: 0, bufferByteOffset: 0 },
                { location: 1, format: GfxFormat.F32_RG, bufferIndex: 0, bufferByteOffset: 8 },
            ],
            vertexBufferDescriptors: [
                { byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex },
            ],
        });
    }

    private createExposureTexture(device: GfxDevice, textureHolder: BRTITextureHolder): void {
        this.exposureTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.F32_RGBA, 1, 1, 1));
        this.resetExposureTexture();
        
        const name = "Exposure";
        textureHolder.gfxTextures.push(this.exposureTexture);
        // TODO: Fill viewer texture with data
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = assertExists(canvas.getContext('2d'));
        const imageData = ctx.createImageData(1, 1);
        imageData.data[0] = 255; imageData.data[1] = 255; imageData.data[2] = 255; imageData.data[3] = 255;
        ctx.putImageData(imageData, 0, 0);
        const viewerTexture: Viewer.Texture = { name, surfaces: [canvas], extraInfo: new Map([['Format', 'F32_RGBA']]) };
        textureHolder.viewerTextures.push(viewerTexture);
        textureHolder.textureNames.push(name);
    }

    private uploadExposureTexture(exposure: number): void {
        if (!this.exposureTexture) return;
        this.exposureTextureData[0] = exposure;
        this.exposureTextureData[1] = exposure;
        this.exposureTextureData[2] = exposure;
        this.exposureTextureData[3] = exposure;
        this.device.uploadTextureData(this.exposureTexture, 0, [this.exposureTextureData]);
    }

    private resetExposureTexture(): void {
        this.autoExposure = 1.0;
        this.uploadExposureTexture(this.autoExposure);
    }

    private updateCPUAutoExposure(viewerInput: Viewer.ViewerRenderInput): void {
        const hdr = OdysseyRenderer.graphicsPreset?.HdrCompose;
        if (hdr === undefined) {
            this.uploadExposureTexture(this.autoExposure);
            return;
        }

        // TODO: move to GPU?
        const rangeMin = Math.max(0.001, Math.min(hdr.AutoExposureRangeMin, hdr.AutoExposureRangeMax));
        const rangeMax = Math.max(rangeMin, Math.max(hdr.AutoExposureRangeMin, hdr.AutoExposureRangeMax));
        const targetExposure = clamp(Math.pow(2.0, hdr.AutoExposureMid), rangeMin, rangeMax);

        const rate = targetExposure > this.autoExposure ? hdr.AutoExposureBlendRateUp : hdr.AutoExposureBlendRateDown;
        const frameScale = Math.max(0.0, viewerInput.deltaTime / (1.0 / 60.0));
        const blend = 1.0 - Math.pow(Math.max(0.0, 1.0 - rate), frameScale);
        this.autoExposure += (targetExposure - this.autoExposure) * blend;
        this.uploadExposureTexture(this.autoExposure);
    }

    private getHdrComposeExposure(): number {
        const preset = OdysseyRenderer.graphicsPreset;
        if (preset === null)
            return 0.001;

        // our debug slider intentionally scales the preset exposure before HdrCompose sees it for better looking numbers
        return Math.max(preset.HdrCompose.Exposure * this.exposure, 0.001);
    }

    private getHdrComposeInvExposure(): number {
        // al::ViewRenderer::drawHdr:
        // if (mHdrCompose)
        //     invExposure = 1.0 / fmaxf(al::HdrCompose::getExposure(mHdrCompose), 0.0001);
        // else
        //     invExposure = 1.6667;
        if (OdysseyRenderer.graphicsPreset === null)
            return 1.6667;

        return 1.0 / Math.max(this.getHdrComposeExposure(), 0.0001);
    }

    private updateExposureSliderLabel(): void {
        this.exposureSlider.setLabel("Exposure: " + this.exposureSlider.getValue());
    }

    private updateLodBiasSliderLabel(): void {
        const totalBias = this.graphicsQualityInfo.globalMipBias + this.debugGlobalLodBiasOffset;
        this.lodBiasSlider.setLabel(`Texture LOD Bias: ${this.debugGlobalLodBiasOffset.toFixed(2)} (total ${totalBias.toFixed(2)})`);
    }

    private updateModelLodDistanceScaleSliderLabel(): void {
        const totalScale = this.graphicsQualityInfo.lodDistanceScale * this.debugModelLodDistanceScale;
        this.modelLodDistanceScaleSlider.setLabel(`Model LOD Distance Scale: ${this.debugModelLodDistanceScale.toFixed(2)}x (total ${totalScale.toFixed(2)}x)`);
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers([...this.skyRenderers, ...this.fmdlRenderers]);

        const cameraPanel = new UI.Panel();

        cameraPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        cameraPanel.setTitle(UI.RENDER_HACKS_ICON, 'Camera Debug');

        this.exposureSlider = new UI.Slider();
        this.exposureSlider.setRange(0, 10, 0.05);
        this.exposureSlider.setValue(1.0);
        this.updateExposureSliderLabel();
        this.exposureSlider.onvalue = () => {
            this.exposure = this.exposureSlider.getValue();
            this.updateExposureSliderLabel();
        };
        cameraPanel.contents.appendChild(this.exposureSlider.elem);

        this.lodBiasSlider = new UI.Slider();
        this.lodBiasSlider.setRange(-5, 5, 0.05);
        this.lodBiasSlider.setValue(0.0);
        this.updateLodBiasSliderLabel();
        this.lodBiasSlider.onvalue = () => {
            this.debugGlobalLodBiasOffset = this.lodBiasSlider.getValue();
            this.updateLodBiasSliderLabel();
        };
        cameraPanel.contents.appendChild(this.lodBiasSlider.elem);

        this.modelLodDistanceScaleSlider = new UI.Slider();
        this.modelLodDistanceScaleSlider.setRange(0.05, 5, 0.05);
        this.modelLodDistanceScaleSlider.setValue(1.0);
        this.updateModelLodDistanceScaleSliderLabel();
        this.modelLodDistanceScaleSlider.onvalue = () => {
            this.debugModelLodDistanceScale = this.modelLodDistanceScaleSlider.getValue();
            this.updateModelLodDistanceScaleSliderLabel();
        };
        cameraPanel.contents.appendChild(this.modelLodDistanceScaleSlider.elem);

        return [cameraPanel, layersPanel];
    }

    private getCameraPos(viewerInput: Viewer.ViewerRenderInput): vec3 {
        return vec3.fromValues(viewerInput.camera.worldMatrix[12], viewerInput.camera.worldMatrix[13], viewerInput.camera.worldMatrix[14]);
    }

    private updateGpuPerfArea(cameraPos: vec3): void {
        let selected: GpuPerfAreaVolume | null = null;
        for (let i = 0; i < this.gpuPerfAreaVolumes.length; i++) {
            const volume = this.gpuPerfAreaVolumes[i];
            if (!volume.containsWorldPoint(cameraPos))
                continue;
            if (selected === null || volume.priority > selected.priority)
                selected = volume;
        }
        this.graphicsQualityInfo.applyGpuPerfAreaParam(selected !== null ? selected.param : null);
    }

    private updateClippingFarArea(cameraPos: vec3): void {
        let selected: ClippingFarAreaVolume | null = null;
        for (let i = 0; i < this.clippingFarAreaVolumes.length; i++) {
            const volume = this.clippingFarAreaVolumes[i];
            if (!volume.containsWorldPoint(cameraPos))
                continue;
            if (selected === null || volume.priority > selected.priority)
                selected = volume;
        }

        this.clippingFarAreaDistance = selected !== null ? selected.farClipDistance : SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE;
        this.clippingFarAreaDistanceSub = selected !== null ? selected.farClipDistanceSub : SMO_DEFAULT_CLIPPING_FAR_AREA_DISTANCE_SUB;
    }

    private updateStageAreas(viewerInput: Viewer.ViewerRenderInput): void {
        const cameraPos = this.getCameraPos(viewerInput);
        this.updateGpuPerfArea(cameraPos);
        this.updateClippingFarArea(cameraPos);
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        this.updateStageAreas(viewerInput);
        const renderInstManager = this.renderHelper.renderInstManager;
        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.modelLodAllCtrl.registerLodCtrl(this.fmdlRenderers[i].modelLodCtrl);
        this.modelLodAllCtrl.update(viewerInput, this.fmdlRenderers, this.graphicsQualityInfo, this.debugModelLodDistanceScale);

        // Sky
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListSky);
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.skyRenderers.length; i++)
            this.skyRenderers[i].prepareToRender(device, renderInstManager, viewerInput, this.simpleModelEnv);
        this.renderHelper.renderInstManager.popTemplate();

        // Main scene
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.fmdlRenderers[i].prepareToRender(device, renderInstManager, viewerInput, this.simpleModelEnv);
        this.renderHelper.renderInstManager.popTemplate();

        // translucent objects on their own render pass
        const mainInsts = this.renderInstListMain.renderInsts;
        for (let i = mainInsts.length - 1; i >= 0; i--) {
            if (!!(getSortKeyLayer(mainInsts[i].sortKey) & GfxRendererLayer.TRANSLUCENT))
                this.renderInstListTranslucent.renderInsts.push(mainInsts.splice(i, 1)[0]);
        }

        this.renderHelper.prepareToRender();
    }

    private renderHdrCompose(device: GfxDevice, builder: any, hdrColorTargetID: GfxrRenderTargetID, viewerInput: Viewer.ViewerRenderInput): GfxrRenderTargetID {
        const ldrColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const ldrColorTargetID = builder.createRenderTargetID(ldrColorDesc, 'LDR Color');

        builder.pushPass((pass: any) => {
            pass.setDebugName('HDR Compose');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, ldrColorTargetID);
            
            const hdrResolveTextureID = builder.resolveRenderTarget(hdrColorTargetID);
            pass.attachResolveTexture(hdrResolveTextureID);

            pass.exec((passRenderer: any, scope: any) => {
                // Get the HDR texture
                const hdrTexture = scope.getResolveTextureForID(hdrResolveTextureID);
                
                const renderInst = this.renderHelper.renderInstManager.newRenderInst();
                renderInst.setUniformBuffer(this.renderHelper.uniformBuffer);
                renderInst.setBindingLayouts(HdrCompose.bindingLayouts);
                
                // Uniforms
                let offs = renderInst.allocateUniformBuffer(HdrCompose.ub_HdrComposeInfo, 60);
                const d = renderInst.mapUniformBufferF32(HdrCompose.ub_HdrComposeInfo);
                const preset = OdysseyRenderer.graphicsPreset!;
                fillHdrComposeUniforms(d, offs, preset, this.exposure);
                
                const textureMapping = new TextureMapping();
                textureMapping.gfxTexture = hdrTexture;
                textureMapping.gfxSampler = this.renderHelper.renderCache.createSampler({
                    wrapS: GfxWrapMode.Clamp,
                    wrapT: GfxWrapMode.Clamp,
                    minFilter: GfxTexFilterMode.Bilinear,
                    magFilter: GfxTexFilterMode.Bilinear,
                    mipFilter: GfxMipFilterMode.Nearest,
                    minLOD: 0, maxLOD: 0,
                });
                
                const exposureMapping = new TextureMapping();
                exposureMapping.gfxTexture = this.exposureTexture!;
                exposureMapping.gfxSampler = textureMapping.gfxSampler;

                renderInst.setSamplerBindingsFromTextureMappings([textureMapping, exposureMapping]);
                
                // Setup geometry
                renderInst.setVertexInput(
                    this.fullscreenInputLayout!,
                    [{ buffer: this.fullscreenVertexBuffer!, byteOffset: 0 }],
                    { buffer: this.fullscreenIndexBuffer!, byteOffset: 0 }
                );
                renderInst.setDrawCount(6);
                
                renderInst.setGfxProgram(this.hdrComposeGfxProgram);
                renderInst.setMegaStateFlags({
                    cullMode: GfxCullMode.None,
                    depthCompare: GfxCompareMode.Always,
                    depthWrite: false,
                });
                
                renderInst.drawOnPass(this.renderHelper.renderCache, passRenderer);
            });
        });

        return ldrColorTargetID;
    }

    private renderFog(builder: any, hdrColorTargetID: GfxrRenderTargetID, linearDepthResolveTextureID: any, viewerInput: Viewer.ViewerRenderInput): void {
        const preset = OdysseyRenderer.graphicsPreset as any;
        if (preset === null || !(preset.Fog?.IsDeferredFog || preset.YFog?.IsDeferredFog))
            return;

        builder.pushPass((pass: any) => {
            pass.setDebugName('Deferred Fog');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, hdrColorTargetID);
            pass.attachResolveTexture(linearDepthResolveTextureID);

            pass.exec((passRenderer: any, scope: any) => {
                const linearDepthTexture = scope.getResolveTextureForID(linearDepthResolveTextureID);

                const renderInst = this.renderHelper.renderInstManager.newRenderInst();
                renderInst.setUniformBuffer(this.renderHelper.uniformBuffer);
                renderInst.setBindingLayouts(RenderFog.bindingLayouts);

                let offs = renderInst.allocateUniformBuffer(RenderFog.ub_RenderFogInfo, 52);
                const d = renderInst.mapUniformBufferF32(RenderFog.ub_RenderFogInfo);
                fillRenderFogUniforms(d, offs, preset, viewerInput);

                const depthMapping = new TextureMapping();
                depthMapping.gfxTexture = linearDepthTexture;
                depthMapping.gfxSampler = this.renderHelper.renderCache.createSampler({
                    wrapS: GfxWrapMode.Clamp,
                    wrapT: GfxWrapMode.Clamp,
                    minFilter: GfxTexFilterMode.Point,
                    magFilter: GfxTexFilterMode.Point,
                    mipFilter: GfxMipFilterMode.Nearest,
                    minLOD: 0, maxLOD: 0,
                });

                const skyCubeMapping = new TextureMapping();
                const cubemapTextureName = 'SkyOnly_' + this.textureHolder.cubeMapSuffixName;
                this.textureHolder.fillTextureMapping(skyCubeMapping, cubemapTextureName);
                skyCubeMapping.gfxSampler = this.renderHelper.renderCache.createSampler({
                    wrapS: GfxWrapMode.Clamp,
                    wrapT: GfxWrapMode.Clamp,
                    minFilter: GfxTexFilterMode.Bilinear,
                    magFilter: GfxTexFilterMode.Bilinear,
                    mipFilter: GfxMipFilterMode.Linear,
                    minLOD: 0, maxLOD: 100,
                });

                renderInst.setSamplerBindingsFromTextureMappings([depthMapping, skyCubeMapping]);

                renderInst.setVertexInput(
                    this.fullscreenInputLayout!,
                    [{ buffer: this.fullscreenVertexBuffer!, byteOffset: 0 }],
                    { buffer: this.fullscreenIndexBuffer!, byteOffset: 0 }
                );
                renderInst.setDrawCount(6);
                renderInst.setGfxProgram(this.renderFogGfxProgram);

                const megaState: Partial<GfxMegaStateDescriptor> = {
                    cullMode: GfxCullMode.None,
                    depthCompare: GfxCompareMode.Always,
                    depthWrite: false,
                };
                setAttachmentStateSimple(megaState, {
                    blendMode: GfxBlendMode.Add,
                    blendSrcFactor: GfxBlendFactor.SrcAlpha,
                    blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
                });
                renderInst.setMegaStateFlags(megaState);

                renderInst.drawOnPass(this.renderHelper.renderCache, passRenderer);
            });
        });
    }

    private renderLinearDepth(device: GfxDevice, builder: any, mainDepthTargetID: GfxrRenderTargetID, viewerInput: Viewer.ViewerRenderInput): GfxrRenderTargetID {
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        mainDepthDesc.pixelFormat = GfxFormat.F32_RGBA;
        
        const linearDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Linear Depth');

        builder.pushPass((pass: any) => {
            pass.setDebugName('Linear Depth');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, linearDepthTargetID);
            
            const mainDepthResolveTextureID = builder.resolveRenderTarget(mainDepthTargetID);
            pass.attachResolveTexture(mainDepthResolveTextureID);

            pass.exec((passRenderer: any, scope: any) => {
                const depthTexture = scope.getResolveTextureForID(mainDepthResolveTextureID);
                
                const renderInst = this.renderHelper.renderInstManager.newRenderInst();
                renderInst.setUniformBuffer(this.renderHelper.uniformBuffer);
                renderInst.setBindingLayouts(LinearDepth.bindingLayouts);
                
                // Uniforms
                let offs = renderInst.allocateUniformBuffer(LinearDepth.ub_LinearDepthInfo, 4);
                const d = renderInst.mapUniformBufferF32(LinearDepth.ub_LinearDepthInfo);

                d[offs++] = viewerInput.camera.near;
                d[offs++] = viewerInput.camera.far;
                offs += 2; // padding
                
                const textureMapping = new TextureMapping();
                textureMapping.gfxTexture = depthTexture;
                textureMapping.gfxSampler = this.renderHelper.renderCache.createSampler({
                    wrapS: GfxWrapMode.Clamp,
                    wrapT: GfxWrapMode.Clamp,
                    minFilter: GfxTexFilterMode.Point,
                    magFilter: GfxTexFilterMode.Point,
                    mipFilter: GfxMipFilterMode.Nearest,
                    minLOD: 0, maxLOD: 0,
                });
                
                renderInst.setSamplerBindingsFromTextureMappings([textureMapping]);
                
                // Setup geometry
                renderInst.setVertexInput(
                    this.fullscreenInputLayout!,
                    [{ buffer: this.fullscreenVertexBuffer!, byteOffset: 0 }],
                    { buffer: this.fullscreenIndexBuffer!, byteOffset: 0 }
                );
                renderInst.setDrawCount(6);
                
                renderInst.setGfxProgram(this.linearDepthGfxProgram);
                renderInst.setMegaStateFlags({
                    cullMode: GfxCullMode.None,
                    depthCompare: GfxCompareMode.Always,
                    depthWrite: false,
                });
                
                renderInst.drawOnPass(this.renderHelper.renderCache, passRenderer);
            });
        });

        return linearDepthTargetID;
    }

    protected clearRequest(): void {
        // TODO: al::ViewRenderer::clearRequest
    }

    protected calcView(graphicsRenderInfo: GraphicsRenderInfo): void {
        // TODO: al::ViewRenderer::calcView
        this.updateStageAreas(graphicsRenderInfo.viewerInput);
        graphicsRenderInfo.viewerInput.camera.setClipPlanes(SMO_NEAR_CLIP, SMO_FAR_CLIP);
    }

    protected preDrawGraphics(_graphicsRenderInfo: GraphicsRenderInfo): void {
        // TODO: al::ViewRenderer::preDrawGraphics
    }

    protected drawSystem(_graphicsRenderInfo: GraphicsRenderInfo, _renderVariables: RenderVariables): void {
        // TODO: al::ViewRenderer::drawSystem:
        // - DepthShadowDrawer::allocAndDrawToDepthShadow 
        // - AtmosScatter / DirectionalLightKeeper directional-light texture update
        // - CubeMapDirector::renderToCubeMap for material-light/reflection sources
        // - WorldAODirector::tryDrawAoTexture
        // - GraphicsSystemInfo::drawSystemPartsGraphics
        // - DepthShadowMapDirector::drawToDepthShadow
        // - ColorCorrection::drawMap
        // - ExecuteDirector custom render targets
    }

    private drawSky(renderVariables: RenderVariables): void {
        const builder = renderVariables.builder;
        builder.pushPass((pass: any) => {
            pass.setDebugName('Sky');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, renderVariables.hdrColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, renderVariables.mainDepthTargetID);
            pass.exec((passRenderer: any) => {
                this.renderInstListSky.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
    }

    private drawMainOpaque(renderVariables: RenderVariables): void {
        const builder = renderVariables.builder;
        builder.pushPass((pass: any) => {
            pass.setDebugName('Main Opaque');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, renderVariables.hdrColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, renderVariables.mainDepthTargetID);
            pass.exec((passRenderer: any) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
    }

    private drawMainTranslucent(graphicsRenderInfo: GraphicsRenderInfo, renderVariables: RenderVariables): void {
        const builder = renderVariables.builder;
        const opaqueColorResolveTextureID = assertExists(renderVariables.opaqueColorResolveTextureID);
        const linearDepthResolveTextureID = assertExists(renderVariables.linearDepthResolveTextureID);

        builder.pushPass((pass: any) => {
            pass.setDebugName('Main Translucent');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, renderVariables.hdrColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, renderVariables.mainDepthTargetID);
            pass.attachResolveTexture(opaqueColorResolveTextureID);
            pass.attachResolveTexture(linearDepthResolveTextureID);
            pass.exec((passRenderer: any, scope: any) => {
                this.renderInstListTranslucent.resolveLateSamplerBinding(kLateBindingFramebuffer, {
                    gfxTexture: scope.getResolveTextureForID(opaqueColorResolveTextureID),
                    gfxSampler: null,
                    lateBinding: null,
                });
                this.renderInstListTranslucent.resolveLateSamplerBinding(kLateBindingLinearDepth, {
                    gfxTexture: scope.getResolveTextureForID(linearDepthResolveTextureID),
                    gfxSampler: null,
                    lateBinding: null,
                });
                this.renderInstListTranslucent.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
    }

    protected drawHdr(graphicsRenderInfo: GraphicsRenderInfo, renderVariables: RenderVariables, drawPlayer: boolean = true, isMirror: boolean = false): void {
        this.simpleModelEnv.updateEnv(graphicsRenderInfo.viewerInput, this.getHdrComposeInvExposure(), this.graphicsQualityInfo, this.debugGlobalLodBiasOffset);

        this.drawSky(renderVariables);
        this.drawMainOpaque(renderVariables);

        renderVariables.linearDepthTargetID = this.renderLinearDepth(
            graphicsRenderInfo.device,
            renderVariables.builder,
            renderVariables.mainDepthTargetID,
            graphicsRenderInfo.viewerInput,
        );
        renderVariables.linearDepthResolveTextureID = renderVariables.builder.resolveRenderTarget(renderVariables.linearDepthTargetID);

        this.renderFog(
            renderVariables.builder,
            renderVariables.hdrColorTargetID,
            renderVariables.linearDepthResolveTextureID,
            graphicsRenderInfo.viewerInput,
        );

        renderVariables.opaqueColorResolveTextureID = renderVariables.builder.resolveRenderTarget(renderVariables.hdrColorTargetID);
        this.drawMainTranslucent(graphicsRenderInfo, renderVariables);
    }

    protected drawView(graphicsRenderInfo: GraphicsRenderInfo, renderVariables: RenderVariables, drawPlayer: boolean = true, isMirror: boolean = false): void {
        // TODO: Add mirror/sub-view handling
        this.calcView(graphicsRenderInfo);
        this.preDrawGraphics(graphicsRenderInfo);
        this.drawSystem(graphicsRenderInfo, renderVariables);
        this.drawHdr(graphicsRenderInfo, renderVariables, drawPlayer, isMirror);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const width  = viewerInput.backbufferWidth;
        const height = viewerInput.backbufferHeight;

        if (!this.textureHolder.linearDepthTexture ||
            this.textureHolder.linearDepthTexture.width  !== width ||
            this.textureHolder.linearDepthTexture.height !== height) {
            this.textureHolder.createLinearDepthTexture(device, width, height);
        }

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const hdrColorDesc = new GfxrRenderTargetDescription(GfxFormat.F16_RGBA_RT);
        hdrColorDesc.setDimensions(viewerInput.backbufferWidth, viewerInput.backbufferHeight, 1);
        hdrColorDesc.clearColor = standardFullClearRenderPassDescriptor.clearColor;
        hdrColorDesc.clearDepth = standardFullClearRenderPassDescriptor.clearDepth;
        hdrColorDesc.clearStencil = standardFullClearRenderPassDescriptor.clearStencil;
        
        // Screen-fetch/refraction samples this in the material HDR path, so it
        // must be an opaque-scene HDR snapshot, not the final LDR backbuffer.
        this.textureHolder.framebufferTexture.setDescription(device, hdrColorDesc);
        
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const hdrColorTargetID = builder.createRenderTargetID(hdrColorDesc, 'HDR Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');

        const graphicsRenderInfo: GraphicsRenderInfo = { device, viewerInput, renderInstManager, viewIndex: 0 };
        const renderVariables = new RenderVariables(builder, hdrColorTargetID, mainDepthTargetID);

        this.clearRequest();
        this.drawView(graphicsRenderInfo, renderVariables);

        // auto-exposure texture update
        this.updateCPUAutoExposure(viewerInput);

        const finalColorTargetID = this.renderHdrCompose(device, builder, hdrColorTargetID, viewerInput);

        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, finalColorTargetID);

        builder.pushPass((pass: any) => {
            pass.setDebugName('Copy to Onscreen Texture');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, finalColorTargetID);
        });
        builder.resolveRenderTargetToExternalTexture(finalColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListSky.reset();
        this.renderInstListMain.reset();
        this.renderInstListTranslucent.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.textureHolder.framebufferTexture.destroy(device);
        
        if (this.hdrTexture)
            device.destroyTexture(this.hdrTexture);
        if (this.exposureTexture)
            device.destroyTexture(this.exposureTexture);
        if (this.fullscreenVertexBuffer)
            device.destroyBuffer(this.fullscreenVertexBuffer);
        if (this.fullscreenIndexBuffer)
            device.destroyBuffer(this.fullscreenIndexBuffer);
        
        for (let i = 0; i < this.skyRenderers.length; i++)
            this.skyRenderers[i].destroy(device);
        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.fmdlRenderers[i].destroy(device);
    }
}
