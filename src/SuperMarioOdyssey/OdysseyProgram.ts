import { FMAT } from "../fres_nx/bfres";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { DeviceProgram } from "../Program";
import { assert, assertExists } from "../util";
import { generateShaderUtil } from "./Shaders/ShaderUtil";

export const ubShapeParams = `
layout(std140) uniform ub_ShapeParams {
    Mat4x4 u_Projection;
    Mat3x4 u_ModelView;
};
`;

export const ubMdlEnvView = `
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
`;

export const ubMaterial = `
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
`;

export const ubModelAdditionalInfo = `
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
`;

export const MaterialUniforms = `
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
uniform sampler2D u_ExposureTexture;
`;

export class OdysseyProgram extends DeviceProgram {
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
    public static _e0: number = 10; // exposure
    public static a_Orders = [ '_p0', '_c0', '_u0', '_n0', '_t0', '_u1', '_u2', '_u3', '_m0', '_lut0', '_e0' ];

    public static ub_ShapeParams = 0;
    public static ub_MdlEnvView = 1; // and ub_HDRTranslate
    public static ub_Material = 2;
    public static ub_ModelAdditionalInfo = 3;
    // ub_MdlMtx  - bone matrices
    // ub_Shp     - shape transform

    constructor(public fmat: FMAT) {
        super();
        this.name = this.fmat.name;
    }

    public override both = generateShaderUtil();

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
            return 'indirectCoords.xy';
        else if  (mtx_select == 21) //indirect coord 1
            return 'indirectCoords.zw';
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
        // 116 is solid
        if (n === 116) return false;
        if (n >= 80 && n <= 85) return this.blendIsTranslucent(n - 80);
        return true; 
    }
}