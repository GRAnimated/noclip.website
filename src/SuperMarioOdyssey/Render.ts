
import * as UI from '../ui.js';
import * as Viewer from '../viewer.js';
import { TextureHolder, TextureMapping } from '../TextureHolder.js';

import { GfxDevice, GfxSampler, GfxWrapMode, GfxMipFilterMode, GfxTexFilterMode, GfxCullMode, GfxCompareMode, GfxInputLayout, GfxBuffer, GfxBufferUsage, GfxFormat, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxBlendMode, GfxBlendFactor, GfxProgram, GfxMegaStateDescriptor, GfxIndexBufferDescriptor, GfxInputLayoutBufferDescriptor, makeTextureDescriptor2D, GfxBufferFrequencyHint, GfxChannelWriteMask, GfxTextureDimension, GfxTextureUsage, GfxSamplerFormatKind, GfxTexture } from '../gfx/platform/GfxPlatform.js';

import * as BNTX from '../fres_nx/bntx.js';
import { surfaceToCanvas } from '../Common/bc_texture.js';
import { translateImageFormat, deswizzle, decompress, getImageFormatString } from '../fres_nx/tegra_texture.js';
import { FMDL, FSHP, FMAT, FMAT_RenderInfo, FMAT_RenderInfoType, FVTX, FSHP_Mesh, FRES, FVTX_VertexAttribute, FVTX_VertexBuffer, Texsrt, parseFMAT_ShaderParam_Float, parseFMAT_ShaderParam_Float2, parseFMAT_ShaderParam_Float3, parseFMAT_ShaderParam_Float4, parseFMAT_ShaderParam_Color3, parseFMAT_ShaderParam_Texsrt } from '../fres_nx/bfres.js';
import { GfxRenderInst, makeSortKey, GfxRendererLayer, setSortKeyDepth, GfxRenderInstManager, GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { TextureAddressMode, FilterMode, IndexFormat, AttributeFormat, getChannelFormat, getTypeFormat } from '../fres_nx/nngfx_enum.js';
import { nArray, assert, assertExists } from '../util.js';
import { fillMatrix4x4, fillMatrix4x3 } from '../gfx/helpers/UniformBufferHelpers.js';
import { mat3, mat4, vec2, vec3, vec4 } from "gl-matrix";
import { computeViewMatrix, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { AABB } from '../Geometry.js';
import { reverseDepthForCompareMode } from '../gfx/helpers/ReversedDepthHelpers.js';
import { DeviceProgram } from '../Program.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { createBufferFromData, createBufferFromSlice } from '../gfx/helpers/BufferHelpers.js';
import { generateRenderMaterialFragment } from './Shaders/alRenderMaterial_Frag.js';
import { generateRenderMaterialVertex } from './Shaders/alRenderMaterial_Vertex.js';
import { generateRenderSkyFragment } from './Shaders/alRenderSky_Frag.js';
import { generateRenderSkyVertex } from './Shaders/alRenderSky_Vertex.js';
import { generateShaderUtil } from './Shaders/ShaderUtil.js';
import { OdysseySceneDesc, GraphicsPreset } from './Scenes.js';
import { convertToCanvasData } from '../gfx/helpers/TextureConversionHelpers.js';
import { MathConstants } from '../MathHelpers.js';

export class BRTITextureHolder extends TextureHolder {
    public addFRESTextures(device: GfxDevice, fres: FRES): void {
        const bntxFile = fres.externalFiles.find((f) => f.name === 'textures.bntx');
        if (bntxFile !== undefined)
            this.addBNTXFile(device, bntxFile.buffer);
    }

    public addBNTXFile(device: GfxDevice, buffer: ArrayBufferSlice): void {
        const bntx = BNTX.parse(buffer);
        for (let i = 0; i < bntx.textures.length; i++) {
            const texName = bntx.textures[i].name;
            // TODO: Load every cubemap
            if (texName.startsWith("Default_") || texName.startsWith("SkyOnly_")) {
                this.addCubemapTexture(device, bntx.textures[i]);
            } else {
                this.addTexture(device, bntx.textures[i]);
            }
        }
    }

    private cropRGBA(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
        const dst = new Uint8Array(dstWidth * dstHeight * 4);

        for (let y = 0; y < dstHeight; y++) {
            const srcRow = y * srcWidth * 4;
            const dstRow = y * dstWidth * 4;
            dst.set(
                src.subarray(srcRow, srcRow + dstWidth * 4),
                dstRow
            );
        }

        return dst;
    }


    public addTexture(device: GfxDevice, textureEntry: BNTX.BRTI): void {
        // Don't add duplicates.
        if (this.textureNames.includes(textureEntry.name))
            return;

        const gfxTexture = device.createTexture(makeTextureDescriptor2D(translateImageFormat(textureEntry.imageFormat), textureEntry.width, textureEntry.height, textureEntry.mipBuffers.length));
        const canvases: HTMLCanvasElement[] = [];

        const channelFormat = getChannelFormat(textureEntry.imageFormat);

        // for (let i = 0; i < textureEntry.mipBuffers.length; i++) {
        for (let i = 0; i < textureEntry.mipBuffers.length; i++) {
            const mipLevel = i;

            const buffer = textureEntry.mipBuffers[i] as ArrayBufferSlice;
            const width = Math.max(textureEntry.width >>> mipLevel, 1);
            const height = Math.max(textureEntry.height >>> mipLevel, 1);
            const depth = 1;
            const blockHeightLog2 = textureEntry.blockHeightLog2;
            deswizzle({ buffer, width, height, channelFormat, blockHeightLog2 }).then((deswizzled) => {
                const rgbaTexture = decompress({ ...textureEntry, width, height, depth }, deswizzled);
                let rgbaPixels = rgbaTexture.pixels;
                rgbaTexture.width = width;
                rgbaTexture.height = height;

                device.uploadTextureData(gfxTexture, mipLevel, [rgbaPixels]);

                const canvas = document.createElement('canvas');
                surfaceToCanvas(canvas, rgbaTexture);
                canvases.push(canvas);
            });
        }

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getImageFormatString(textureEntry.imageFormat));

        const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases, extraInfo };
        this.gfxTextures.push(gfxTexture);
        this.viewerTextures.push(viewerTexture);
        this.textureNames.push(textureEntry.name);
    }

    public addCubemapTexture(device: GfxDevice, textureEntry: BNTX.BRTI): void {
        // Don't add duplicates.
        if (this.textureNames.includes(textureEntry.name))
            return;

        const numFaces = 6;
        const numMips = textureEntry.mipBuffers.length;
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
        let processedMips = 0;

        for (let mipLevel = 0; mipLevel < numMips; mipLevel++) {
            const width = Math.max(textureEntry.width >>> mipLevel, 1);
            const height = Math.max(textureEntry.height >>> mipLevel, 1);
            const depth = 1;
            const blockHeightLog2 = textureEntry.blockHeightLog2;

            const levelDatas: ArrayBufferView[] = [];
            
            for (let faceIdx = 0; faceIdx < numFaces; faceIdx++) {
                const mipBuffer = textureEntry.mipBuffers[mipLevel];
                const buffer = Array.isArray(mipBuffer) ? mipBuffer[faceIdx] as ArrayBufferSlice : mipBuffer as ArrayBufferSlice;
                
                deswizzle({ buffer, width, height, channelFormat, blockHeightLog2 }).then((deswizzled) => {
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
                        processedMips++;
                        
                        if (processedMips === numMips) {
                            device.uploadTextureData(gfxTexture, 0, allLevelDatas);
                        }
                    }
                    
                    if (mipLevel === 0 && faceIdx === 0) {
                        const canvas = document.createElement('canvas');
                        surfaceToCanvas(canvas, rgbaTexture);
                        canvases.push(canvas);
                    }
                });
            }
        }

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getImageFormatString(textureEntry.imageFormat));

        const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases, extraInfo };
        this.gfxTextures.push(gfxTexture);
        this.viewerTextures.push(viewerTexture);
        this.textureNames.push(textureEntry.name);
    }

    public addLUTTexture(device: GfxDevice, width: number, color: { r: number; g: number; b: number; a: number }): void {
        const data = new Float32Array(width * 4);
        for (let i = 0; i < width; i++) {
            const o = i * 4;
            data[o + 0] = color.r / 255.0;
            data[o + 1] = color.g / 255.0;
            data[o + 2] = color.b / 255.0;
            data[o + 3] = color.a / 255.0;
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
    public indirect1_scale: vec2 = vec2.create();
    public proc_texture_3d_scale = vec3.fromValues(1, 1, 1);
    public translucence_sharpness = 0.0;
    public translucence_sharpness_strength = 0.0;
    public translucence_factor = 0.0;
    public translucence_silhouette_stress = 0.0;
    public cloth_nov_peak_pos0 = 0.0;
    public cloth_nov_peak_pow0 = 0.0;
    public cloth_nov_tone_intensity0 = 0.0;
    public cloth_nov_tone_pow0 = 0.0;
    public cloth_nov_slope0 = 0.0;
    public cloth_nov_emission_scale0 = 0.0;
    public cloth_nov_noise_mask_scale0 = 0.0;
    public force_roughness = 1.0;
    public material_lod_roughness = 1.0;
    public material_lod_metalness = 0.0;
    public alpha_test_value = 0.5;
    public wrap_coef = 0.0;
    public refract_thickness = 0.0;
    public stain_rate = 1.0;
}

class ModelAdditionalInfo {
    public model_alpha_mask = 1.0;
    public normal_axis_x_scale = 1.0;
    public uv_offset = vec2.create();
    public proj_mtx0 = mat4.create();
    public proj_mtx1 = mat4.create();
    public proj_mtx2 = mat4.create();
    public proj_mtx3 = mat4.create();
}

export class AglProgram extends DeviceProgram {
    public static _p0: number = 0;
    public static _c0: number = 1;
    public static _u0: number = 2;
    public static _n0: number = 3;
    public static _t0: number = 4;
    public static _u1: number = 5;
    public static _u2: number = 6;
    public static _u3: number = 7;
    public static _m0: number = 8; // cubemap
    public static _lut0: number = 9; // cDirectionalLightColor
    public static a_Orders = [ '_p0', '_c0', '_u0', '_n0', '_t0', '_u1', '_u2', '_u3', '_m0', '_lut0' ];

    public static ub_ShapeParams = 0;
    public static ub_MdlEnvView = 1; // and ub_HDRTranslate
    public static ub_Material = 2;
    public static ub_ModelAdditionalInfo = 3;
    // ub_MdlMtx  - bone matrices
    // ub_Shp     - shape transform

    public isTranslucent: boolean = false;

    constructor(public fmat: FMAT) {
        super();

        this.name = this.fmat.name;
        assert(this.fmat.samplerInfo.length <= 8);

        if (this.fmat.shaderAssign.shaderArchiveName === 'alRenderSky') {
            this.frag = generateShaderUtil() + generateRenderSkyFragment(this);
            this.vert = generateShaderUtil() + generateRenderSkyVertex();
            return;
        }

        if (this.getShaderOptionNumber('vtxcolor_type') >= 0)
            this.defines.set('OPT_vtxcolor', '1');

        let alphaIsTranslucent = false;
        try {
            alphaIsTranslucent = this.outputIsTranslucent('o_alpha');
        } catch(e) {
        }

        this.isTranslucent = alphaIsTranslucent && !this.getShaderOptionBoolean(`enable_alphamask`);

        this.frag = generateShaderUtil() + generateRenderMaterialFragment(this);
        this.vert = generateShaderUtil() + generateRenderMaterialVertex(this);
    }

    public static globalDefinitions = `
precision mediump float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_ShapeParams {
    Mat4x4 u_Projection;
    Mat3x4 u_ModelView;
};

layout(std140) uniform ub_MdlEnvView {
    float HDRTranslate_uHDRPower;     // moved here due to reduce the amount of uniform buffers
    float HDRTranslate_uDynamicRange;
    vec2 _padding0;
    vec4 cDirLightViewDirFetchPos; // Directional light
    
    Mat3x4 cView;
    Mat3x4 cViewInv;
    Mat4x4 cViewProj;
    Mat3x4 cInvProjView;
    vec4 _padding1;
    Mat4x4 cInvProj;
    Mat3x4 uInvProjViewNoTrans;

    float cInvExposure;
    float uIrradianceScale;
    vec2 _padding2;
    
    float cNear;
    float cFar;
    float cRange;
    float cInvRange;
    vec2 cTanFovyHalf;
    vec2 cScrProjOffset;
    vec4 cScrSize;
    vec3 cCameraPos;
    float _padding3;

    // Fog here since we're short on uniform blocks
    vec4 cFogColor;         // .rgb = color, .a = slope
    float cFogStart;
    float cFogMax;
    vec2 _padding4;
    vec4 cYFogColor;        // .rgb = color, .a = slope
    float cYFogStart;
    float cYFogMax;
    vec3 cViewAxisY;
    float _padding5;
    vec3 cViewAxisZ;
    float _padding6;
} mdlEnvView;

layout(std140) uniform ub_Material {
    vec4 const_color0;
    vec4 const_color1;
    vec4 const_color2;
    vec4 const_color3;
    float const_single0;
    float const_single1;
    float const_single2;
    float const_single3;
    vec4 base_color_mul_color;
    vec4 uniform0_mul_color;
    vec4 uniform1_mul_color;
    vec4 uniform2_mul_color;
    vec4 uniform3_mul_color;
    vec4 uniform4_mul_color;
    vec4 proc_texture_2d_mul_color;
    vec4 proc_texture_3d_mul_color;
    mat2x4 tex_mtx0;
    mat2x4 tex_mtx1;
    mat2x4 tex_mtx2;
    mat2x4 tex_mtx3;
    float displacement_scale;
    float displacement1_scale;
    vec2 padding;
    vec4 displacement_color;
    vec4 displacement1_color;
    float wrap_coef;
    float refract_thickness;
    vec2 indirect0_scale;
    vec2 indirect1_scale;
    float alpha_test_value;
    float force_roughness;
    float sphere_rate_color0;
    float sphere_rate_color1;
    float sphere_rate_color2;
    float sphere_rate_color3;
    mat4 mirror_view_proj;
    float decal_range;
    float gbuf_fetch_offset;
    float translucence_sharpness;
    float translucence_sharpness_strength;
    float translucence_factor;
    float translucence_silhouette_stress;
    float indirect_depth_scale;
    float cloth_nov_peak_pos0;
    float cloth_nov_peak_pow0;
    float cloth_nov_peak_intensity0;
    float cloth_nov_tone_pow0;
    float cloth_nov_slope0;
    float cloth_nov_emission_scale0;
    vec3 cloth_nov_noise_mask_scale0;
    vec4 proc_texture_3d_scale;
    // vec4 flow0_param;
    vec4 ripple_emission_color;
    vec4 hack_color;
    vec4 stain_color;
    float stain_uv_scale;
    float stain_rate;
    float material_lod_roughness;
    float material_lod_metalness;
} mat;

layout(std140) uniform ub_ModelAdditionalInfo {
    float model_alpha_mask;
    float normal_axis_x_scale;
    vec2 uv_offset;
    mat4 proj_mtx0;
    mat4 proj_mtx1;
    mat4 proj_mtx2;
    mat4 proj_mtx3;
    vec4 prog_constant0;
    vec4 prog_constant1;
} modelInfo;

uniform sampler2D u_Texture0;
uniform sampler2D u_Texture1;
uniform sampler2D u_Texture2;
uniform sampler2D u_Texture3;
uniform sampler2D u_Texture4;
uniform sampler2D u_Texture5;
uniform sampler2D u_Texture6;
uniform sampler2D u_Texture7;
uniform samplerCube u_CubemapTexture0;
uniform sampler2D u_DirectionalLightLUT;
`;

    public override both = AglProgram.globalDefinitions;

    public lookupSamplerIndex(shadingModelSamplerBindingName: string) {
        // Translate to a local sampler by looking in the sampler map, and then that's the index we use.
        const samplerName = assertExists(this.fmat.shaderAssign.samplerAssign.get(shadingModelSamplerBindingName));
        const samplerIndex = this.fmat.samplerInfo.findIndex((sampler) => sampler.name === samplerName);
        assert(samplerIndex >= 0);
        return samplerIndex;
    }

    public getShaderOptionNumber(optionName: string): number {
        const optionValue = assertExists(this.fmat.shaderAssign.shaderOption.get(optionName), `Shader option ${optionName} not found in material ${this.fmat.name}`);
        return +optionValue;
    }

    public getShaderOptionBoolean(optionName: string): boolean {
        const optionValue = assertExists(this.fmat.shaderAssign.shaderOption.get(optionName), `Shader option ${optionName} not found in material ${this.fmat.name}`);
        assert(optionValue === '0' || optionValue === '1');
        return optionValue === '1';
    }

    public condShaderOption(optionName: string, branchTrue: () => string, branchFalse: () => string = () => ''): string {
        return this.getShaderOptionBoolean(optionName) ? branchTrue() : branchFalse();
    }

    public selectTexCoord(mtx_select: number): string {
        if (mtx_select == 10)  //tex coord 0
            return 'v_TexCoord0';
        else if  (mtx_select == 11) //tex coord 1
            return 'v_TexCoord1';
        else if  (mtx_select == 12) //tex coord 2
            return 'v_TexCoord2';
        else if  (mtx_select == 13) //tex coord 3
            return 'v_TexCoord3';
        else if  (mtx_select == 20) //indirect coord 0
            return 'v_IrradianceVertex.xy'; // is this right?
        else if  (mtx_select == 21) //indirect coord 1
            return 'v_IrradianceVertex.zw'; // same here
        else if  (mtx_select == 30) //sphere mapping
            return 'v_SphereCoords.xy';
        else //TODO 50 - 54 are proj texture types
            return 'v_TexCoord0.xy';
    }

    public genSample(shadingModelSamplerBindingName: string, texCoord: string, additional: string = ''): string {
        try {
            const samplerIndex = this.lookupSamplerIndex(shadingModelSamplerBindingName);
            const uv = texCoord;
            return `texture(u_Texture${samplerIndex}, vec2(${uv}.x, ${uv}.y)${additional})`;
        } catch(e) {
            // TODO(jstpierre): Figure out wtf is going on.
            // console.warn(`${this.name}: No sampler by name ${shadingModelSamplerBindingName}`);
            return `vec4(1.0)`;
        }
    }

    public genCubeSample(shadingModelSamplerBindingName: string, direction: string): string {
        try {
            const samplerIndex = this.lookupSamplerIndex(shadingModelSamplerBindingName);
            return `texture(u_CubemapTexture${samplerIndex}, normalize(${direction}))`;
        } catch (e) {
            return `vec4(1.0)`;
        }
    }

    public genUniform(num: number, additional: string = 'vec2(0.0)'): string {
        const shaderSamplerName = `_u${num}`;
        
        let textureUnit: number;
        try {
            textureUnit = this.lookupSamplerIndex(shaderSamplerName);
        } catch(e) {
            return `vec4(1.0)`; // no texture bound
        }
        
        return `
            CalculateUniform(u_Texture${textureUnit},
            ${this.getShaderOptionNumber(`uniform${num}_fuv_selector`)},
            ${this.getShaderOptionBoolean(`enable_uniform${num}`)},
            mat.uniform${num}_mul_color,
            ${this.getShaderOptionBoolean(`enable_uniform${num}_mul_color`)},
            ${this.getShaderOptionBoolean(`enable_uniform${num}_mul_vtxcolor`)},
            ${this.getShaderOptionBoolean(`enable_uniform${num}_roughness_lod`)},
            ${additional})
        `;
    }

    public genOutput(optionName: string): string {
        const n = this.getShaderOptionNumber(optionName);

        return `CalculateOutput(${n})`;
    }

    public blendIsTranslucent(instance: number): boolean {
        if (!this.getShaderOptionBoolean(`enable_blend${instance}`)) return false;
        return this.outputIsTranslucent(`blend${instance}_src`);
    }

    public outputIsTranslucent(optionName: string): boolean {
        const n = this.getShaderOptionNumber(optionName);
        // 115 is 0.0
        // 116 is 1.0
        // 116 is solid
        if (n === 116) return false;
        if (n >= 80 && n <= 85) return this.blendIsTranslucent(n - 80);
        return true; 
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
    private program: AglProgram;
    private gfxProgram: GfxProgram;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;
    private materialParams = new MaterialParams();

    constructor(device: GfxDevice, cache: GfxRenderCache, textureHolder: BRTITextureHolder, public fmat: FMAT) {
        this.program = new AglProgram(fmat);

        // Fill in our texture mappings.
        assert(fmat.samplerInfo.length === fmat.textureName.length);

        this.textureMapping = nArray(11, () => new TextureMapping());
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

            const textureName = fmat.textureName[i];
            textureHolder.fillTextureMapping(this.textureMapping[i], textureName);
            (this.textureMapping[i] as any).name = textureName;
            this.textureMapping[i].gfxSampler = gfxSampler;
        }

        const cubemapTextureName = textureHolder.textureNames.find(name => name === 'Default_');
        if (cubemapTextureName) {
            const gfxSampler = cache.createSampler({
                minFilter: GfxTexFilterMode.Bilinear,
                magFilter: GfxTexFilterMode.Bilinear,
                mipFilter: GfxMipFilterMode.Linear,
                minLOD: 0,
                maxLOD: 100,
                wrapS: GfxWrapMode.Clamp,
                wrapT: GfxWrapMode.Clamp,
            });
            this.gfxSamplers.push(gfxSampler);

            textureHolder.fillTextureMapping(this.textureMapping[AglProgram._m0], cubemapTextureName);
            this.textureMapping[AglProgram._m0].gfxSampler = gfxSampler;
        } else {
            console.info('No cubemap found for material', fmat.name);
        }

        const lutSampler = createDirectionalLightSampler(cache);
        this.gfxSamplers.push(lutSampler);

        textureHolder.fillTextureMapping(this.textureMapping[AglProgram._lut0], "LUT");
        this.textureMapping[AglProgram._lut0].gfxSampler = lutSampler;

        this.gfxProgram = cache.createProgram(this.program);

        const isTranslucent = this.program.isTranslucent;
        if (fmat.shaderAssign.shaderArchiveName === 'alRenderSky') {
            this.megaStateFlags = {
                cullMode:       GfxCullMode.None,
                depthCompare:   GfxCompareMode.Always,
                depthWrite:     false,
            };
        } else {
            this.megaStateFlags = {
                cullMode:       translateCullMode(fmat),
                depthCompare:   reverseDepthForCompareMode(translateDepthCompare(fmat)),
                depthWrite:     isTranslucent ? false : translateDepthWrite(fmat),
            };
        }
        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: isTranslucent ? translateBlendSrcFactor(fmat) : GfxBlendFactor.One,
            blendDstFactor: isTranslucent ? translateBlendDstFactor(fmat) : GfxBlendFactor.Zero,
        });

        this.parseMaterialParams(fmat);
    }

    // TODO: include material uniforms
    public setOnRenderInst(device: GfxDevice, renderInst: GfxRenderInst): void {
        const isTranslucent = this.program.isTranslucent;
        const materialLayer = isTranslucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        renderInst.sortKey = makeSortKey(materialLayer, 0);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setMegaStateFlags(this.megaStateFlags);
    }

    public destroy(device: GfxDevice): void {
        device.destroyProgram(this.gfxProgram);
    }

    private parseMaterialParams(fmat: FMAT): void {
        const params = fmat.shaderParam;

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
                case 'cloth_nov_tone_intensity0':
                case 'cloth_nov_tone_pow0':
                case 'cloth_nov_slope0':
                case 'cloth_nov_emission_scale0':
                case 'cloth_nov_noise_mask_scale0':
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
                    this.materialParams[p.name] = parseFMAT_ShaderParam_Float(p);
                    break;

                case 'indirect1_scale':
                    if (!this.materialParams[p.name]) this.materialParams[p.name] = vec2.create();
                    parseFMAT_ShaderParam_Float2(this.materialParams[p.name], p);
                    break;

                case 'proc_texture_3d_scale':
                    if (!this.materialParams[p.name]) this.materialParams[p.name] = vec3.create();
                    parseFMAT_ShaderParam_Float3(this.materialParams[p.name], p);
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
                    if (!this.materialParams[p.name]) this.materialParams[p.name] = vec4.create();
                    parseFMAT_ShaderParam_Float4(this.materialParams[p.name], p);
                    break;

                case 'tex_mtx0':
                case 'tex_mtx1':
                case 'tex_mtx2':
                case 'tex_mtx3':
                    if (!this.materialParams[p.name]) this.materialParams[p.name] = { mode: 0, scaleS: 1, scaleT: 1, rotation: 0, translationS: 0, translationT: 0 };
                    parseFMAT_ShaderParam_Texsrt(this.materialParams[p.name], p);
                    break;

                case 'mirror_view_proj':
                    // TODO: mirror_view_proj
                    break;

                default:
                    // console.warn(`Unknown material parameter: ${p.name}`);
                    break;
            }
        }
    }

    public fillMaterialParams(d: Float32Array, offs: number): number {
        offs += fillVec4(d, offs, this.materialParams.const_color0);
        offs += fillVec4(d, offs, this.materialParams.const_color1);
        offs += fillVec4(d, offs, this.materialParams.const_color2);
        offs += fillVec4(d, offs, this.materialParams.const_color3);
        
        d[offs++] = this.materialParams.const_single0;
        d[offs++] = this.materialParams.const_single1;
        d[offs++] = this.materialParams.const_single2;
        d[offs++] = this.materialParams.const_single3;
        
        // mul colors
        offs += fillVec4(d, offs, this.materialParams.base_color_mul_color);
        offs += fillVec4(d, offs, this.materialParams.uniform0_mul_color);
        offs += fillVec4(d, offs, this.materialParams.uniform1_mul_color);
        offs += fillVec4(d, offs, this.materialParams.uniform2_mul_color);
        offs += fillVec4(d, offs, this.materialParams.uniform3_mul_color);
        offs += fillVec4(d, offs, this.materialParams.uniform4_mul_color);
        offs += fillVec4(d, offs, this.materialParams.proc_texture_2d_mul_color);
        offs += fillVec4(d, offs, this.materialParams.proc_texture_3d_mul_color);
        
        // texture matrices (mat2x4 = 2 vec4s)
        offs += fillTexsrtAsMatrix2x4(d, offs, this.materialParams.tex_mtx0);
        offs += fillTexsrtAsMatrix2x4(d, offs, this.materialParams.tex_mtx1);
        offs += fillTexsrtAsMatrix2x4(d, offs, this.materialParams.tex_mtx2);
        offs += fillTexsrtAsMatrix2x4(d, offs, this.materialParams.tex_mtx3);
        
        d[offs++] = this.materialParams.displacement_scale;
        d[offs++] = this.materialParams.displacement1_scale;
        offs += 2; // padding
        
        offs += fillVec4(d, offs, this.materialParams.displacement_color);
        offs += fillVec4(d, offs, this.materialParams.displacement1_color);
        
        d[offs++] = this.materialParams.wrap_coef;
        d[offs++] = this.materialParams.refract_thickness;

        // indirect0_scale
        d[offs++] = 0.0;
        d[offs++] = 0.0;
        
        // indirect1_scale (vec2)
        d[offs++] = this.materialParams.indirect1_scale[0];
        d[offs++] = this.materialParams.indirect1_scale[1];
        
        d[offs++] = this.materialParams.alpha_test_value;
        d[offs++] = this.materialParams.force_roughness;
        
        d[offs++] = this.materialParams.sphere_rate_color0;
        d[offs++] = this.materialParams.sphere_rate_color1;
        d[offs++] = this.materialParams.sphere_rate_color2;
        d[offs++] = this.materialParams.sphere_rate_color3;
        
        // mirror_view_proj
        for (let i = 0; i < 16; i++) {
            d[offs++] = 0.0; // TODO: figure out mirror_view_proj
        }
        
        d[offs++] = this.materialParams.decal_range;
        d[offs++] = this.materialParams.gbuf_fetch_offset;
        d[offs++] = this.materialParams.translucence_sharpness;
        d[offs++] = this.materialParams.translucence_sharpness_strength;
        
        d[offs++] = this.materialParams.translucence_factor;
        d[offs++] = this.materialParams.translucence_silhouette_stress;
        d[offs++] = this.materialParams.indirect_depth_scale;
        d[offs++] = this.materialParams.cloth_nov_peak_pos0;
        d[offs++] = this.materialParams.cloth_nov_peak_pow0;
        d[offs++] = this.materialParams.cloth_nov_tone_intensity0;
        d[offs++] = this.materialParams.cloth_nov_tone_pow0;
        d[offs++] = this.materialParams.cloth_nov_slope0;
        
        d[offs++] = this.materialParams.cloth_nov_emission_scale0;
        
        // cloth_nov_noise_mask_scale0 (vec3)
        d[offs++] = this.materialParams.cloth_nov_noise_mask_scale0;
        d[offs++] = 0.0;
        d[offs++] = 0.0;
        
        // proc_texture_3d_scale (vec4, but vec3 in shader params)
        d[offs++] = this.materialParams.proc_texture_3d_scale[0];
        d[offs++] = this.materialParams.proc_texture_3d_scale[1];
        d[offs++] = this.materialParams.proc_texture_3d_scale[2];
        d[offs++] = 1.0;
        
        // flow0_param?
        
        offs += fillVec4(d, offs, this.materialParams.ripple_emission_color);
        offs += fillVec4(d, offs, this.materialParams.hack_color);
        offs += fillVec4(d, offs, this.materialParams.stain_color);
        
        d[offs++] = this.materialParams.stain_uv_scale;
        d[offs++] = this.materialParams.stain_rate;
        d[offs++] = this.materialParams.material_lod_roughness;
        d[offs++] = this.materialParams.material_lod_metalness;
        
        return offs;
    }
}

function fillVec4(d: Float32Array, offs: number, v: vec4): number {
    d[offs++] = v[0];
    d[offs++] = v[1];
    d[offs++] = v[2];
    d[offs++] = v[3];
    return 4;
}

function fillTexsrtAsMatrix2x4(d: Float32Array, offs: number, texsrt: Texsrt): number {
    const c = Math.cos(texsrt.rotation);
    const s = Math.sin(texsrt.rotation);
    
    d[offs++] = texsrt.scaleS * c;
    d[offs++] = texsrt.scaleT * -s;
    d[offs++] = 0.0;
    d[offs++] = texsrt.translationS;
    
    d[offs++] = texsrt.scaleS * s;
    d[offs++] = texsrt.scaleT * c;
    d[offs++] = 0.0;
    d[offs++] = texsrt.translationT;
    
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
    default:
        console.error(getChannelFormat(attributeFormat), getTypeFormat(attributeFormat));
        throw "whoops";
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

            const attribLocation = AglProgram.a_Orders.indexOf(vertexAttribute.name);
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

    constructor(cache: GfxRenderCache, public mesh: FSHP_Mesh, fvtxData: FVTXData) {
        const indexBufferFormat = translateIndexFormat(mesh.indexFormat);
        this.inputLayout = cache.createInputLayout({
            indexBufferFormat,
            vertexAttributeDescriptors: fvtxData.vertexAttributeDescriptors,
            vertexBufferDescriptors: fvtxData.inputBufferDescriptors,
        });
    
        this.vertexBufferDescriptors = fvtxData.vertexBufferDescriptors;
        this.indexBuffer = createBufferFromSlice(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, mesh.indexBufferData);
        this.indexBufferDescriptor = { buffer: this.indexBuffer };
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

export class FMDLData {
    public fvtxData: FVTXData[] = [];
    public fshpData: FSHPData[] = [];

    constructor(cache: GfxRenderCache, public fmdl: FMDL) {
        for (let i = 0; i < fmdl.fvtx.length; i++)
            this.fvtxData.push(new FVTXData(cache.device, fmdl.fvtx[i]));
        for (let i = 0; i < fmdl.fshp.length; i++) {
            const fshp = fmdl.fshp[i];
            this.fshpData.push(new FSHPData(cache, fshp, this.fvtxData[fshp.vertexIndex]));
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.fvtxData.length; i++)
            this.fvtxData[i].destroy(device);
        for (let i = 0; i < this.fshpData.length; i++)
            this.fshpData[i].destroy(device);
    }
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
        assert(this.meshData.mesh.offset === 0);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        // TODO(jstpierre): Do we have to care about submeshes?
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.meshData.mesh.count);
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
const bboxScratch = new AABB();
class FSHPInstance {
    public lodMeshInstances: FSHPMeshInstance[] = [];
    public visible = true;
    public enableCulling = true;

    constructor(public fshpData: FSHPData, private fmatInstance: FMATInstance) {
        // Only construct the first LOD mesh for now.
        for (let i = 0; i < 1; i++)
            this.lodMeshInstances.push(new FSHPMeshInstance(fshpData.meshData[i]));
    }

    public computeModelView(modelMatrix: mat4, viewerInput: Viewer.ViewerRenderInput): mat4 {
        // Build view matrix
        const viewMatrix = scratchMatrix;
        computeViewMatrix(viewMatrix, viewerInput.camera);
        mat4.mul(viewMatrix, viewMatrix, modelMatrix);
        return viewMatrix;
    }

    private fillMdlEnvView(d: Float32Array, offs: number, viewerInput: Viewer.ViewerRenderInput, modelMatrix: mat4): number {
        const preset = OdysseySceneDesc.graphicsPreset!;
        
        d[offs++] = 1.0;  // HDRTranslate_uHDRPower
        d[offs++] = 2.2;  // HDRTranslate_uDynamicRange
        offs += 2;          // padding

        const dir = latLonToDirection(preset.DirectionalLight.DirectionParam.Y, preset.DirectionalLight.DirectionParam.X);
        
        // const lightDir = vec3.fromValues(0.3, 0.9, -0.2);
        const lightDir = vec3.fromValues(-dir.x, -dir.y, -dir.z);
        vec3.normalize(lightDir, lightDir);
        // cDirLightViewDirFetchPos
        d[offs++] = lightDir[0];
        d[offs++] = lightDir[1];
        d[offs++] = lightDir[2];
        d[offs++] = 0.5; // LUT position

        console.log(`Light Dir: (${lightDir[0].toFixed(3)}, ${lightDir[1].toFixed(3)}, ${lightDir[2].toFixed(3)})`);

        const viewMatrix = scratchMatrix;
        computeViewMatrix(viewMatrix, viewerInput.camera);
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
        d[offs++] = 1.0;  // cInvExposure
        d[offs++] = 1.0;  // uIrradianceScale
        offs += 2;
        
        d[offs++] = 0.1;      // cNear
        d[offs++] = 100000.0; // cFar
        d[offs++] = 100000.0 - 0.1;  // cRange
        d[offs++] = 1.0 / (100000.0 - 0.1); // cInvRange
        
        // cTanFovyHalf (vec2)
        d[offs++] = 1.0;  // cTanFovyHalf.x
        d[offs++] = 1.0;  // cTanFovyHalf.y
        // cScrProjOffset (vec2)
        d[offs++] = 0.0;  // cScrProjOffset.x
        d[offs++] = 0.0;  // cScrProjOffset.y
        
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

        const fog = preset.Fog;
        const yFog = preset.YFog;

        // Fog parameters
        // cFogColor
        d[offs++] = fog.Color.R / 255.0;
        d[offs++] = fog.Color.G / 255.0;
        d[offs++] = fog.Color.B / 255.0;
        // d[offs++] = 1.0;
        // d[offs++] = 0.0;
        // d[offs++] = 0.0;
        d[offs++] = fog.IsEnable ? fog.Slope / 1000.0 : 0.0;
        
        d[offs++] = fog.Start;
        d[offs++] = fog.Max;
        offs += 2; // padding
        
        // cYFogColor
        d[offs++] = yFog.Color.R / 255.0;
        d[offs++] = yFog.Color.G / 255.0;
        d[offs++] = yFog.Color.B / 255.0;
        // d[offs++] = yFog.IsEnable ? yFog.Slope / 1000.0 : 0.0;
        d[offs++] = 0.0; // TODO: y fog is broken
        
        d[offs++] = yFog.Start;
        d[offs++] = yFog.Max;
        
        // cViewAxisY
        const worldUp = vec3.fromValues(0.0, 1.0, 0.0);
        const viewAxisY = vec3.create();
        vec3.transformMat3(viewAxisY, worldUp, mat3.fromMat4(mat3.create(), viewMatrix));
        d[offs++] = viewAxisY[0];
        d[offs++] = viewAxisY[1];
        d[offs++] = viewAxisY[2];
        offs += 1; // padding
        
        // cViewAxisZ
        const worldForward = vec3.fromValues(0.0, 0.0, 1.0);
        const viewAxisZ = vec3.create();
        vec3.transformMat3(viewAxisZ, worldForward, mat3.fromMat4(mat3.create(), viewMatrix));
        d[offs++] = viewAxisZ[0];
        d[offs++] = viewAxisZ[1];
        d[offs++] = viewAxisZ[2];
        offs += 1; // padding

        
        return offs;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, modelMatrix: mat4, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        // TODO(jstpierre): Joints.
        const template = renderInstManager.pushTemplate();

        // ub_ShapeParams
        let offs = template.allocateUniformBuffer(AglProgram.ub_ShapeParams, 16+12);
        const d = template.mapUniformBufferF32(AglProgram.ub_ShapeParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x3(d, offs, this.computeModelView(modelMatrix, viewerInput));
         
        // ub_MdlEnvView has camera, environment, now ub_HDRTranslate, and now fog data
        const mdlEnvOffs = template.allocateUniformBuffer(AglProgram.ub_MdlEnvView, 148);
        const envData = template.mapUniformBufferF32(AglProgram.ub_MdlEnvView);
        this.fillMdlEnvView(envData, mdlEnvOffs, viewerInput, modelMatrix);
         
        // ub_Material
        const matOffs = template.allocateUniformBuffer(AglProgram.ub_Material, 200); // TODO: calculate right size
        const matData = template.mapUniformBufferF32(AglProgram.ub_Material);
        this.fmatInstance.fillMaterialParams(matData, matOffs);
 
        // ub_ModelAdditionalInfo
        template.allocateUniformBuffer(AglProgram.ub_ModelAdditionalInfo, 16 + 16 + 8 + 64 + 64 + 64 + 64 + 16 + 16);
        const modelAddData = template.mapUniformBufferF32(AglProgram.ub_ModelAdditionalInfo);
        
        this.fmatInstance.setOnRenderInst(device, template);

        for (let i = 0; i < this.lodMeshInstances.length; i++) {
            bboxScratch.transform(this.lodMeshInstances[i].meshData.mesh.bbox, modelMatrix);
            if (this.enableCulling && !viewerInput.camera.frustum.contains(bboxScratch))
                continue;

            this.lodMeshInstances[i].prepareToRender(device, renderInstManager, viewerInput);
        }

        renderInstManager.popTemplate();
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 4, numSamplers: 10, samplerEntries: [
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.Cube, formatKind: GfxSamplerFormatKind.Float, },
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat, },
    ] }
];

export class FMDLRenderer {
    public fmatInst: FMATInstance[] = [];
    public fshpInst: FSHPInstance[] = [];
    public modelMatrix = mat4.create();
    public visible = true;
    public name: string;

    constructor(device: GfxDevice, cache: GfxRenderCache, public textureHolder: BRTITextureHolder, public fmdlData: FMDLData) {
        const fmdl = this.fmdlData.fmdl;
        this.name = fmdl.name;

        for (let i = 0; i < fmdl.fmat.length; i++)
            this.fmatInst.push(new FMATInstance(device, cache, this.textureHolder, fmdl.fmat[i]));

        for (let i = 0; i < this.fmdlData.fshpData.length; i++) {
            const fshpData = this.fmdlData.fshpData[i];
            const fmatInstance = this.fmatInst[fshpData.fshp.materialIndex];
            this.fshpInst.push(new FSHPInstance(fshpData, fmatInstance));
        }
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplate();
        template.setBindingLayouts(bindingLayouts);

        for (let i = 0; i < this.fshpInst.length; i++)
            this.fshpInst[i].prepareToRender(device, renderInstManager, this.modelMatrix, viewerInput);

        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.fmatInst.length; i++)
            this.fmatInst[i].destroy(device);
    }
}

export class SkyRenderer extends FMDLRenderer {
    constructor(device: GfxDevice, cache: GfxRenderCache, textureHolder: BRTITextureHolder, fmdlData: FMDLData) {
        super(device, cache, textureHolder, fmdlData);

        for (let i = 0; i < this.fshpInst.length; i++) {
            this.fshpInst[i].enableCulling = false;

            // HACK: Moons get culled out after rotation, this bypasses it
            const meshData = this.fshpInst[i].lodMeshInstances[0].meshData;
            meshData.mesh.bbox.min[0] = -1000000;
            meshData.mesh.bbox.min[1] = -1000000;
            meshData.mesh.bbox.min[2] = -1000000;
            meshData.mesh.bbox.max[0] = 1000000;
            meshData.mesh.bbox.max[1] = 1000000;
            meshData.mesh.bbox.max[2] = 1000000;
        }
    }

    public override prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        // mat4.identity(this.modelMatrix);

        const template = renderInstManager.pushTemplate();
        template.setBindingLayouts(bindingLayouts);

        for (let i = 0; i < this.fshpInst.length; i++) {
            this.fshpInst[i].prepareToRender(device, renderInstManager, this.modelMatrix, viewerInput);
        }

        renderInstManager.popTemplate();
    }
}

export class BasicFRESRenderer {
    public renderHelper: GfxRenderHelper;
    private renderInstListSky = new GfxRenderInstList();
    private renderInstListMain = new GfxRenderInstList();
    public fmdlRenderers: FMDLRenderer[] = [];
    public skyRenderers: SkyRenderer[] = [];

    constructor(device: GfxDevice, public textureHolder: BRTITextureHolder) {
        this.renderHelper = new GfxRenderHelper(device);
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers([...this.skyRenderers, ...this.fmdlRenderers]);
        return [layersPanel];
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;

        // Sky
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListSky);
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.skyRenderers.length; i++)
            this.skyRenderers[i].prepareToRender(device, renderInstManager, viewerInput);
        this.renderHelper.renderInstManager.popTemplate();

        // Main scene
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.fmdlRenderers[i].prepareToRender(device, renderInstManager, viewerInput);
        this.renderHelper.renderInstManager.popTemplate();

        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');

        const camera = viewerInput.camera;
        camera.setClipPlanes(10, 1000000);
        
        // Sky first
        builder.pushPass((pass) => {
            pass.setDebugName('Sky');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListSky.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListSky.reset();
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        for (let i = 0; i < this.skyRenderers.length; i++)
            this.skyRenderers[i].destroy(device);
        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.fmdlRenderers[i].destroy(device);
    }
}
