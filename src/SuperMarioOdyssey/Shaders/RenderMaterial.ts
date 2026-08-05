import { FMAT } from "../../fres_nx/bfres.js";
import { MaterialUniforms, OdysseyProgram, ubMaterial, ubMdlEnvView, ubModelAdditionalInfo, ubShapeParams } from "../OdysseyProgram.js";
import { generateFogCode } from "./FogUtil.js";
import { generateShaderUtil } from "./ShaderUtil.js";

export class RenderMaterial extends OdysseyProgram {
    public isTranslucent: boolean = false;
    public usePremultipliedAlphaBlend: boolean = false;

    constructor(fmat: FMAT, private isRippleMaterial: boolean = false) {
        super(fmat);

        if (this.getShaderOptionNumber('vtxcolor_type') >= 0)
            this.defines.set('OPT_vtxcolor', '1');

        let alphaIsTranslucent = false;
        try {
            alphaIsTranslucent = this.outputIsTranslucent('o_alpha');
        } catch (e) {}

        // cRenderType == 3 uses render info forward_xlu to decide Opa vs XLU
        // so treat type 3 as potentially translucent

        const renderType = this.getShaderOptionNumber('cRenderType');
        const forwardXluInfo = fmat.renderInfo.get('forward_xlu');
        const forwardXlu = forwardXluInfo !== undefined && forwardXluInfo.values.length > 0 ? forwardXluInfo.values[0] as string : 'Opa';
        const deferredXluInfo = fmat.renderInfo.get('deferred_xlu');
        const deferredXlu = deferredXluInfo !== undefined && deferredXluInfo.values.length > 0 ? deferredXluInfo.values[0] as string : '';
        const additiveXlu = forwardXlu.includes('Add') || deferredXlu.includes('Add');
        if (additiveXlu)
            this.defines.set('OPT_ADDITIVE_XLU', '1');
        const renderTypeIsXlu = renderType === 1 || (renderType === 3 && forwardXlu !== 'Opa');
        this.isTranslucent = (alphaIsTranslucent || this.getShaderOptionBoolean('enable_transparent') || renderTypeIsXlu) && !this.getShaderOptionBoolean(`enable_alphamask`);

        const rgbSrcBlend = fmat.renderInfo.get('color_blend_rgb_src_func')?.values[0];
        const rgbDstBlend = fmat.renderInfo.get('color_blend_rgb_dst_func')?.values[0];
        this.usePremultipliedAlphaBlend = this.isTranslucent && !additiveXlu && rgbSrcBlend === 'src_alpha' && rgbDstBlend === 'one_minus_src_alpha';
        if (this.usePremultipliedAlphaBlend)
            this.defines.set('OPT_PREMULTIPLIED_ALPHA_BLEND', '1');

        if (isRippleMaterial)
            this.defines.set('OPT_RIPPLE_MATERIAL', '1');

this.both += `
${ubShapeParams}
${ubMdlEnvView}
${ubMaterial}
${ubModelAdditionalInfo}
${MaterialUniforms}

const float ENCODE_BASE	= 0.25;

/*
void CalcHdrToLdr(out vec4 ldr, vec4 hdr) {
    float head_value = max(max(hdr.r, hdr.g), hdr.b);
    const float base_rcp = 1.0 / ENCODE_BASE;
    head_value += fract(1.0 - (head_value * base_rcp)) * ENCODE_BASE;
    head_value = max(head_value, 1.0 / 256.0);
    float texel_correct_value = clamp01(head_value / mdlEnvView.HDRTranslate_uDynamicRange);
    texel_correct_value = pow(texel_correct_value, 1.0 / mdlEnvView.HDRTranslate_uHDRPower);
    ldr.rgb = hdr.rgb / head_value;
    ldr.a = texel_correct_value;
}
*/

void CalcLdrToHdr(out vec4 hdr, vec4 ldr) {
    float scale = pow(ldr.a, mdlEnvView.HDRTranslate_uHDRPower) * mdlEnvView.HDRTranslate_uDynamicRange;
    hdr = vec4(ldr.rgb * scale, scale);
}
`;

this.frag = `
in vec3 v_Normal;
in vec3 v_WorldPos;
in vec3 v_LocalPos;
in float v_Depth;
in vec4 v_Tangents;
in vec4 v_Bitangents;
in vec4 v_ViewPos;
in vec4 v_LightColorVPosZ;
in vec2 v_TexCoord0;
in vec2 v_TexCoord1;
in vec2 v_TexCoord2;
in vec2 v_TexCoord3;
in vec4 v_VtxColor;
in vec4 v_IrradianceVertex;
in vec2 v_SphereCoords;
in vec4 v_PerspDiv;
in vec4 v_IndirectCoords;

${ generateFogCode() }

vec4 indirectCoords;

vec2 SelectTexCoord(int mtx_select)
{
    if (mtx_select == 10)  //tex coord 0
        return v_TexCoord0;
    else if  (mtx_select == 11) //tex coord 1
        return v_TexCoord1;
    else if  (mtx_select == 12) //tex coord 2
        return v_TexCoord2;
    else if  (mtx_select == 13) //tex coord 3
        return v_TexCoord3;
    else if  (mtx_select == 20) //indirect coord 0
        return indirectCoords.xy;
    else if  (mtx_select == 21) //indirect coord 1
        return indirectCoords.zw;
    else if  (mtx_select == 30) //sphere mapping
        return v_SphereCoords.xy;
    else if (mtx_select == 50) //proj texture 0
        return (vec4(v_LocalPos.xyz, 1.0) * modelInfo.proj_mtx0).xy;
    else if (mtx_select == 51) //proj texture 1
        return (vec4(v_LocalPos.xyz, 1.0) * modelInfo.proj_mtx1).xy;
    else if (mtx_select == 52) //proj texture 2
        return (vec4(v_LocalPos.xyz, 1.0) * modelInfo.proj_mtx2).xy;
    else if (mtx_select == 53) //proj texture 3
        return (vec4(v_LocalPos.xyz, 1.0) * modelInfo.proj_mtx3).xy;
    else
        return v_TexCoord0.xy;
}

vec3 GetWorldNormal() {
    return normalize(v_Normal);
}

vec3 GetWorldBitangent() {
    return normalize(vec3(v_Tangents.w, v_Bitangents.xy));
}

vec3 GetWorldTangent() {
    return normalize(v_Tangents.xyz);
}

vec4 CalculateUniform(sampler2D cTexture, int uv_selector, bool enable, vec4 mul_color,
    bool enable_mul_color, bool enable_mul_vtx_color, bool enable_roughness_lod, vec2 tex_bias)
{
    vec4 uniform_output = vec4(1.0);
    vec2 uv = SelectTexCoord(uv_selector);
    if (enable)
        uniform_output = texture(cTexture, uv + tex_bias, mdlEnvView.cGlobalLodBias);
    if (enable_roughness_lod)
        uniform_output = textureLod(cTexture, uv, 0.0);
    if (enable_mul_color)
        uniform_output *= mul_color;
    if (enable_mul_vtx_color)
        uniform_output *= v_VtxColor;

    return uniform_output;
}

vec3 calcSpecularGGX(float roughness, float metalness, vec3 f0, vec3 N, vec3 V, vec3 L, vec3 H)
{
    float N_H = saturate(dot(N, H));
    float L_H = saturate(dot(L, H));
    float N_V = saturate(dot(N, V));
    float N_L = saturate(dot(N, L));

    // GGX normal distribution term
    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;
    float denom = N_H * N_H * (alpha2 - 1.0) + 1.0;
    float piDenom2 = PI * denom * denom;
    float D = alpha2 / max(piDenom2, 0.0005);

    // Schlick Fresnel and visibility term based on alLightingFunction.glsl's FV_Helper
    float dotLH5 = pow(1.0 - L_H, 5.0);
    float k = alpha * 0.5;
    float k2 = k * k;
    float vis = (abs(N_V) * N_L) / (L_H * L_H * (1.0 - k2) + k2);
    vec3 FV = f0 * ((1.0 - dotLH5) * vis) + vec3(dotLH5 * vis);

    float spcCavityCoef = mix(1.0 - roughness * roughness, 1.0, metalness) * 0.5;
    return FV * (N_L * D * spcCavityCoef);
}

vec3 ReconstructNormal(in vec2 t_NormalXY) {
    float t_NormalZ = sqrt(clamp(1.0 - dot(t_NormalXY.xy, t_NormalXY.xy), 0.0, 1.0));
    return vec3(t_NormalXY.xy, t_NormalZ);
}

vec3 CalculateNormals(vec3 normals, vec2 normal_map)
{
    if (${this.getShaderOptionBoolean('enable_normal')} == false)
        return normals;

    vec3 N = vec3(normals);
    vec3 T = vec3(v_Tangents.xyz);
    vec3 B = vec3(v_Tangents.w, v_Bitangents.xy);

    // mat3 tbn_matrix = mat3(T, B, N);

    vec3 tangent_normal = N;
    if (${this.getShaderOptionBoolean('enable_normal')} == true)
    {
        tangent_normal = ReconstructNormal(normal_map);
    }
    // tbn_matrix multiplication
    vec3 world_normal = normalize(
        tangent_normal.x * T +
        tangent_normal.y * B +
        tangent_normal.z * N
    );
    return world_normal;
}

float CalculateSphereLight() {
    vec3 vertex_normal = normalize(v_Normal);
    if (${this.getShaderOptionBoolean('is_use_back_face_lighting')} == true)
        vertex_normal = 1.0 - vertex_normal;

    vec3 view_normal = normalize(rotMtx34Vec3(mdlEnvView.cView, vertex_normal));
    vec3 view_pos = vec3(v_ViewPos.zw, v_LightColorVPosZ.w);

    vec3 dir = normalize(view_pos);

    return clamp(fma(dir.z, -view_normal.z,
                    fma(dir.x, -view_normal.x, 
                    dir.y * -view_normal.y)), 0.0, 1.0);
}

float calcFresnel(float hFresnelN, float V_H)
{
#if 1
	// Spherical Gaussian approximation Fresnel
	const float a1 = -5.55473;
	const float a2 = -6.98316;
	return hFresnelN + (1.0 - hFresnelN) * exp2((a1 * V_H + a2) * V_H);
#else
	// Disney's Fresnel
	float V_H2 = V_H*V_H;
	float V_H5 = V_H2*V_H2*V_H;
	return mix(hFresnelN, 1.0, V_H5);
#endif
}

vec4 CalculateSphereConstColor(int sphere_color_type, vec4 const_color, float sphere_rate_color) {
    float cosTheta = CalculateSphereLight();

    if (sphere_color_type == 1) // inverted fresnel effect
    {
        float amount = clamp(exp2(log2(cosTheta) * sphere_rate_color), 0.0, 1.0);
        return const_color * amount;
    }
    else if (sphere_color_type == 2) // fresnel effect
    {
        float amount = clamp(exp2(log2(1.0 - cosTheta) * sphere_rate_color), 0.0, 1.0);
        return const_color * amount;
    }
    else
        return const_color; // type 0 defaults to const color
}

vec4 GetCompBlend(vec4 v, int comp_mask)
{
    if      (comp_mask == 10)  return v.rgba;
    else if (comp_mask == 20)  return v.rrrr;
    else if (comp_mask == 30)  return v.gggg;
    else if (comp_mask == 40)  return v.bbbb;
    else if (comp_mask == 50)  return v.aaaa;
    else if (comp_mask == 11)  return 1.0 - v.rgba;
    else if (comp_mask == 21)  return 1.0 - v.rrrr;
    else if (comp_mask == 31)  return 1.0 - v.gggg;
    else if (comp_mask == 41)  return 1.0 - v.bbbb;
    else if (comp_mask == 51)  return 1.0 - v.aaaa;
    return v.rgba;
}

vec4 GetComp(vec4 v, int comp_mask)
{
    if      (comp_mask == 10)  return v.rgba;
    else if (comp_mask == 30)  return v.rrrr;
    else if (comp_mask == 40)  return v.gggg;
    else if (comp_mask == 50)  return v.bbbb;
    else if (comp_mask == 60)  return v.aaaa;
    else if (comp_mask == 70)  return clamp(1.0 - v.rrrr, 0.0, 1.0);
    else if (comp_mask == 80)  return clamp(1.0 - v.gggg, 0.0, 1.0);
    else if (comp_mask == 90)  return clamp(1.0 - v.bbbb, 0.0, 1.0);
    else if (comp_mask == 100) return clamp(1.0 - v.aaaa, 0.0, 1.0);

    return v.rgba;
}

vec4 CalculateProcTexture2D() {
    if (${this.getShaderOptionBoolean('enable_proc_texture_2d')} == false)
        return vec4(0.0);

    vec2 tex_coords = SelectTexCoord(${this.getShaderOptionNumber('proc_texture_2d_fuv_selector')});
    vec4 proc_tex = GetComp(texture(u_TextureProcTexture2D, tex_coords), ${this.getShaderOptionNumber('proc_texture_2d_component')});

    if (${this.getShaderOptionBoolean('enable_proc_texture_2d_mul_color')} == true)
        proc_tex *= mat.proc_texture_3d_mul_color;

    if (${this.getShaderOptionBoolean('enable_proc_texture_2d_mul_vtxcolor')} == true)
        proc_tex *= v_VtxColor;

    return proc_tex;
}

vec4 CalculateProcTexture3D() {
    if (${this.getShaderOptionBoolean('enable_proc_texture_3d')} == false)
        return vec4(0.0);

    vec3 tex_coords_3d = v_LocalPos.xyz * mat.proc_texture_3d_scale.xyz;
    int fuv_offset = ${this.getShaderOptionNumber('proc_texture_3d_fuv_offset')};
    if      (fuv_offset == 60) tex_coords_3d += mat.const_color0.xyz;
    else if (fuv_offset == 61) tex_coords_3d += mat.const_color1.xyz;
    else if (fuv_offset == 62) tex_coords_3d += mat.const_color2.xyz;
    else if (fuv_offset == 63) tex_coords_3d += mat.const_color3.xyz;

    vec4 proc_tex = GetComp(texture(u_TextureProcTexture3D, tex_coords_3d), ${this.getShaderOptionNumber('proc_texture_3d_component')});

    if (${this.getShaderOptionBoolean('enable_proc_texture_3d_mul_color')} == true)
        proc_tex *= mat.proc_texture_3d_mul_color;

    if (${this.getShaderOptionBoolean('enable_proc_texture_3d_mul_vtxcolor')} == true)
        proc_tex *= v_VtxColor;

    return proc_tex;
}

vec4 CalculateBaseColor(vec2 tex_bias)
{
    vec4 basecolor_output = vec4(1.0);
    if (${this.getShaderOptionBoolean('enable_base_color')})
        basecolor_output = (${this.genSample("_a0", this.selectTexCoord(this.getShaderOptionNumber('base_color_fuv_selector')), ' + tex_bias, mdlEnvView.cGlobalLodBias')});
    if (${this.getShaderOptionBoolean('enable_base_color_mul_color')})
        basecolor_output *= mat.base_color_mul_color;
    if (${this.getShaderOptionNumber('vtxcolor_type') == 0}) // VTX_COLOR_TYPE_DIFFUSE
        basecolor_output.rgb *= v_VtxColor.rgb;
    else if (${this.getShaderOptionNumber('vtxcolor_type') == 3}) // VTX_COLOR_TYPE_DIFFUSE_BLEND
       basecolor_output.rgb *= (1.0 - v_VtxColor.rgb * v_VtxColor.rgb);

    return basecolor_output;
}

vec4 BLEND0_OUTPUT;
vec4 BLEND1_OUTPUT;
vec4 BLEND2_OUTPUT;
vec4 BLEND3_OUTPUT;
vec4 BLEND4_OUTPUT;
vec4 BLEND5_OUTPUT;

vec2 GetScreenCoordinates()
{
	vec2 screenCoord = v_PerspDiv.xy * 0.5 + 0.5;
    screenCoord.y = 1.0 - screenCoord.y;
    return screenCoord;
}

vec2 GetResolvedTextureCoordinates()
{
    // vertex shader was causing distortion
    // return v_PerspDiv.xy * 0.5 + 0.5;

    return gl_FragCoord.xy * mdlEnvView.cScrSize.zw;
}

vec4 CalculateOutput(int flag)
{
    if (flag == 10) return CalculateBaseColor(vec2(0.0));
    else if (flag == 15) return v_VtxColor;
    else if (flag == 20) {
        // Normal map
        return ${this.genSample("_n0", this.selectTexCoord(this.getShaderOptionNumber('normal_fuv_selector')))};
    }
    else if (flag == 30) return vec4(GetWorldNormal().xyz, 0.0); // World Normal

    else if (flag == 50) return ${this.genUniform(0)};
    else if (flag == 51) return ${this.genUniform(1)};
    else if (flag == 52) return ${this.genUniform(2)};
    else if (flag == 53) return ${this.genUniform(3)};
    else if (flag == 54) return ${this.genUniform(4)};
    else if (flag == 60) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color0')}, mat.const_color0, mat.sphere_rate_color0);
    else if (flag == 61) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color1')}, mat.const_color1, mat.sphere_rate_color1);
    else if (flag == 62) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color2')}, mat.const_color2, mat.sphere_rate_color2);
    else if (flag == 63) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color3')}, mat.const_color3, mat.sphere_rate_color3);

    else if (flag == 70) return texture(u_FrameBufferTexture, GetResolvedTextureCoordinates());
    else if (flag == 78) return texture(u_TextureLinearDepth, GetResolvedTextureCoordinates());

    else if (flag == 80) return BLEND0_OUTPUT;
    else if (flag == 81) return BLEND1_OUTPUT;
    else if (flag == 82) return BLEND2_OUTPUT;
    else if (flag == 83) return BLEND3_OUTPUT;
    else if (flag == 84) return BLEND4_OUTPUT;
    else if (flag == 85) return BLEND5_OUTPUT;

    else if (flag == 110) return vec4(mat.const_single0);
    else if (flag == 111) return vec4(mat.const_single1);
    else if (flag == 112) return vec4(mat.const_single2);
    else if (flag == 113) return vec4(mat.const_single3);

    else if (flag == 115) return vec4(0.0);
    else if (flag == 116) return vec4(1.0);
    else if (flag == 140) return vec4(modelInfo.uv_offset, 0.0, 0.0);
    else if (flag == 160) return CalculateProcTexture2D(); // ProcTexture2D
    else if (flag == 170) return CalculateProcTexture3D();

    return vec4(0.0);
}

vec4 GetTransparentTexOutput(int flag, float bias_x, float bias_y)
{
    vec2 bias = vec2(bias_x, bias_y);

    if (flag == 10)      return CalculateBaseColor(bias);
    else if (flag == 50) return ${this.genUniform(0, 'bias')};
    else if (flag == 51) return ${this.genUniform(1, 'bias')};
    else if (flag == 52) return ${this.genUniform(2, 'bias')};
    else if (flag == 53) return ${this.genUniform(3, 'bias')};
    else if (flag == 54) return ${this.genUniform(4, 'bias')};
    return vec4(0.0);
}

vec4 CalculateCofBlendOutput(int flag, int cof_map)
{
    if (flag == 10)      return v_VtxColor;
    else if (flag == 20) return CalculateOutput(cof_map);

    else if (flag == 30) return vec4(mat.const_single0);
    else if (flag == 31) return vec4(mat.const_single1);
    else if (flag == 32) return vec4(mat.const_single2);
    else if (flag == 33) return vec4(mat.const_single3);

    else if (flag == 60) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color0')}, mat.const_color0, mat.sphere_rate_color0);
    else if (flag == 61) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color1')}, mat.const_color1, mat.sphere_rate_color1);
    else if (flag == 62) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color2')}, mat.const_color2, mat.sphere_rate_color2);
    else if (flag == 63) return CalculateSphereConstColor(${this.getShaderOptionNumber('sphere_const_color3')}, mat.const_color3, mat.sphere_rate_color3);

    else if (flag == 115) return vec4(0.0);
    else if (flag == 116) return vec4(1.0);

    return vec4(0.0);
}

float BlendCompareComponent(float src, float dst, float cof)
{
    float cmp = (src < 0.5) ? 0.0 : 1.0;
    float n = -2.0 * src + 2.0;
    float func = 2.0 * src * dst * cof + 2.0 * src - src * cof;
    return func + cmp * (-func - dst * cof * (-n) + cmp);
}

vec4 CalculateBlend(bool enable, int src_id, int dst_id, int cof_id, int cof_map, int src_ch, int dst_ch, int cof_ch, int equation) {
    if (!enable)
        return vec4(0.0);

    vec4 src = GetCompBlend(CalculateOutput(src_id), src_ch);
    vec4 dst = GetCompBlend(CalculateOutput(dst_id), dst_ch);
    vec4 cof = GetCompBlend(CalculateCofBlendOutput(cof_id, cof_map), cof_ch);

    if      (equation == 0) return fma(src - dst, cof, dst);
    else if (equation == 1) return fma(dst, cof, src);
    else if (equation == 2) return dst * cof * src;
    else if (equation == 3) return fma(dst, 0.0 - cof, src); 
    else if (equation == 4) return dst + cof + src; 
    else if (equation == 5) return fma(dst * cof, 0.0 - src, dst * cof) + src;
    else if (equation == 6) //Compare func 
    {
        src.x = BlendCompareComponent(src.x, dst.x, cof.x);
        src.y = BlendCompareComponent(src.y, dst.y, cof.y);
        src.z = BlendCompareComponent(src.z, dst.z, cof.z);
        src.w = BlendCompareComponent(src.w, dst.w, cof.w);
        return src;
    }
    else if (equation == 7) return (src + dst) * cof; 
    else if (equation == 8) return (src - dst) * cof; 

    return src;
}

void TryCalculateReferencedBlend(int flag) {
    if (flag == 80) BLEND0_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend0')}, ${this.getShaderOptionNumber('blend0_src')}, ${this.getShaderOptionNumber('blend0_dst')}, ${this.getShaderOptionNumber('blend0_cof')}, ${this.getShaderOptionNumber('blend0_cof_map')}, ${this.getShaderOptionNumber('blend0_src_ch')}, ${this.getShaderOptionNumber('blend0_dst_ch')}, ${this.getShaderOptionNumber('blend0_cof_ch')}, ${this.getShaderOptionNumber('blend0_eq')});
    else if (flag == 81) BLEND1_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend1')}, ${this.getShaderOptionNumber('blend1_src')}, ${this.getShaderOptionNumber('blend1_dst')}, ${this.getShaderOptionNumber('blend1_cof')}, ${this.getShaderOptionNumber('blend1_cof_map')}, ${this.getShaderOptionNumber('blend1_src_ch')}, ${this.getShaderOptionNumber('blend1_dst_ch')}, ${this.getShaderOptionNumber('blend1_cof_ch')}, ${this.getShaderOptionNumber('blend1_eq')});
    else if (flag == 82) BLEND2_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend2')}, ${this.getShaderOptionNumber('blend2_src')}, ${this.getShaderOptionNumber('blend2_dst')}, ${this.getShaderOptionNumber('blend2_cof')}, ${this.getShaderOptionNumber('blend2_cof_map')}, ${this.getShaderOptionNumber('blend2_src_ch')}, ${this.getShaderOptionNumber('blend2_dst_ch')}, ${this.getShaderOptionNumber('blend2_cof_ch')}, ${this.getShaderOptionNumber('blend2_eq')});
    else if (flag == 83) BLEND3_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend3')}, ${this.getShaderOptionNumber('blend3_src')}, ${this.getShaderOptionNumber('blend3_dst')}, ${this.getShaderOptionNumber('blend3_cof')}, ${this.getShaderOptionNumber('blend3_cof_map')}, ${this.getShaderOptionNumber('blend3_src_ch')}, ${this.getShaderOptionNumber('blend3_dst_ch')}, ${this.getShaderOptionNumber('blend3_cof_ch')}, ${this.getShaderOptionNumber('blend3_eq')});
    else if (flag == 84) BLEND4_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend4')}, ${this.getShaderOptionNumber('blend4_src')}, ${this.getShaderOptionNumber('blend4_dst')}, ${this.getShaderOptionNumber('blend4_cof')}, ${this.getShaderOptionNumber('blend4_cof_map')}, ${this.getShaderOptionNumber('blend4_src_ch')}, ${this.getShaderOptionNumber('blend4_dst_ch')}, ${this.getShaderOptionNumber('blend4_cof_ch')}, ${this.getShaderOptionNumber('blend4_eq')});
    else if (flag == 85) BLEND5_OUTPUT = CalculateBlend(${this.getShaderOptionBoolean('enable_blend5')}, ${this.getShaderOptionNumber('blend5_src')}, ${this.getShaderOptionNumber('blend5_dst')}, ${this.getShaderOptionNumber('blend5_cof')}, ${this.getShaderOptionNumber('blend5_cof_map')}, ${this.getShaderOptionNumber('blend5_src_ch')}, ${this.getShaderOptionNumber('blend5_dst_ch')}, ${this.getShaderOptionNumber('blend5_cof_ch')}, ${this.getShaderOptionNumber('blend5_eq')});
}

void PrecomputeBlends() {
    bool enable_blend =      ${this.getShaderOptionBoolean('enable_blend0')};
    int blend_src =          ${this.getShaderOptionNumber('blend0_src')};
    int blend_dst =          ${this.getShaderOptionNumber('blend0_dst')};
    int blend_cof =          ${this.getShaderOptionNumber('blend0_cof')};
    int blend_cof_map =      ${this.getShaderOptionNumber('blend0_cof_map')};
    int blend_src_ch =       ${this.getShaderOptionNumber('blend0_src_ch')};
    int blend_dst_ch =       ${this.getShaderOptionNumber('blend0_dst_ch')};
    int blend_cof_ch =       ${this.getShaderOptionNumber('blend0_cof_ch')};
    int blend_eq =           ${this.getShaderOptionNumber('blend0_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND0_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
    
    enable_blend =       ${this.getShaderOptionBoolean('enable_blend1')};
    blend_src =          ${this.getShaderOptionNumber('blend1_src')};
    blend_dst =          ${this.getShaderOptionNumber('blend1_dst')};
    blend_cof =          ${this.getShaderOptionNumber('blend1_cof')};
    blend_cof_map =      ${this.getShaderOptionNumber('blend1_cof_map')};
    blend_src_ch =       ${this.getShaderOptionNumber('blend1_src_ch')};
    blend_dst_ch =       ${this.getShaderOptionNumber('blend1_dst_ch')};
    blend_cof_ch =       ${this.getShaderOptionNumber('blend1_cof_ch')};
    blend_eq =           ${this.getShaderOptionNumber('blend1_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND1_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
    
    enable_blend =       ${this.getShaderOptionBoolean('enable_blend2')};
    blend_src =          ${this.getShaderOptionNumber('blend2_src')};
    blend_dst =          ${this.getShaderOptionNumber('blend2_dst')};
    blend_cof =          ${this.getShaderOptionNumber('blend2_cof')};
    blend_cof_map =      ${this.getShaderOptionNumber('blend2_cof_map')};
    blend_src_ch =       ${this.getShaderOptionNumber('blend2_src_ch')};
    blend_dst_ch =       ${this.getShaderOptionNumber('blend2_dst_ch')};
    blend_cof_ch =       ${this.getShaderOptionNumber('blend2_cof_ch')};
    blend_eq =           ${this.getShaderOptionNumber('blend2_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND2_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
    
    enable_blend =       ${this.getShaderOptionBoolean('enable_blend3')};
    blend_src =          ${this.getShaderOptionNumber('blend3_src')};
    blend_dst =          ${this.getShaderOptionNumber('blend3_dst')};
    blend_cof =          ${this.getShaderOptionNumber('blend3_cof')};
    blend_cof_map =      ${this.getShaderOptionNumber('blend3_cof_map')};
    blend_src_ch =       ${this.getShaderOptionNumber('blend3_src_ch')};
    blend_dst_ch =       ${this.getShaderOptionNumber('blend3_dst_ch')};
    blend_cof_ch =       ${this.getShaderOptionNumber('blend3_cof_ch')};
    blend_eq =           ${this.getShaderOptionNumber('blend3_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND3_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
    
    enable_blend =       ${this.getShaderOptionBoolean('enable_blend4')};
    blend_src =          ${this.getShaderOptionNumber('blend4_src')};
    blend_dst =          ${this.getShaderOptionNumber('blend4_dst')};
    blend_cof =          ${this.getShaderOptionNumber('blend4_cof')};
    blend_cof_map =      ${this.getShaderOptionNumber('blend4_cof_map')};
    blend_src_ch =       ${this.getShaderOptionNumber('blend4_src_ch')};
    blend_dst_ch =       ${this.getShaderOptionNumber('blend4_dst_ch')};
    blend_cof_ch =       ${this.getShaderOptionNumber('blend4_cof_ch')};
    blend_eq =           ${this.getShaderOptionNumber('blend4_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND4_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);

    enable_blend =       ${this.getShaderOptionBoolean('enable_blend5')};
    blend_src =          ${this.getShaderOptionNumber('blend5_src')};
    blend_dst =          ${this.getShaderOptionNumber('blend5_dst')};
    blend_cof =          ${this.getShaderOptionNumber('blend5_cof')};
    blend_cof_map =      ${this.getShaderOptionNumber('blend5_cof_map')};
    blend_src_ch =       ${this.getShaderOptionNumber('blend5_src_ch')};
    blend_dst_ch =       ${this.getShaderOptionNumber('blend5_dst_ch')};
    blend_cof_ch =       ${this.getShaderOptionNumber('blend5_cof_ch')};
    blend_eq =           ${this.getShaderOptionNumber('blend5_eq')};
    TryCalculateReferencedBlend(blend_src);
    TryCalculateReferencedBlend(blend_dst);
    TryCalculateReferencedBlend(blend_cof_map);
    BLEND5_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
}

vec3 CalculateEmissionScale(vec3 emission, int scale_type, vec4 irradiance)
{
    //Emission scale
    if (scale_type == 1) // emission * irradiance, max by emission
        emission = max(irradiance.rgb * emission.rgb, emission.rgb);
    else if (scale_type == 2) // emission * irradiance, max by 1.0
        emission = emission * max(irradiance.rgb, 1.0);
    else if (scale_type == 3) // emission * irradiance color
        emission = emission * irradiance.rgb;
    else if (scale_type == 4) // emission * irradiance scale
        emission = emission * irradiance.w;
    else if (scale_type == 5) // max irradiance light amount
    {
        float max_scale = max(max(irradiance.g, irradiance.b), irradiance.r);
        emission = max_scale * emission;
    }
    else if (scale_type == 6) // max irradiance light amount maxed by emission amount
    {
        float max_scale = max(max(irradiance.g, irradiance.b), irradiance.r);
        emission = max(vec3(max_scale) * emission, emission);
    }
    else if (scale_type == 7) // exposure scale    
    {   
        float exposure = texture(u_ExposureTexture, vec2(0.0, 0.0)).a;
        emission *= 1.0 / exposure * mdlEnvView.cInvExposure;
    }
    return emission;
}

vec3 CalculateEmission(vec4 irradiance)
{
    vec3 emission = vec3(0.0);

    if (${this.getShaderOptionBoolean('enable_emission')} == true)
    {
        emission = GetComp(${this.genOutput('o_emission')}, ${this.getShaderOptionNumber('emission_component')}).rgb;

        if (${this.getShaderOptionNumber('vtxcolor_type')} == 2) // VTX_COLOR_TYPE_EMISSION
            emission *= v_VtxColor.rgb;

        //Emission scale
        int emission_scale_type = ${this.getShaderOptionNumber('emission_scale_type')};
        emission = CalculateEmissionScale(emission, emission_scale_type, irradiance);
    }
    return emission;
}

vec3 CalculateClothEmission(vec4 irradiance)
{
    vec3 emission = ${this.genOutput('o_cloth_emission_map')}.rgb * mat.cloth_nov_emission_scale0;
    return CalculateEmissionScale(emission, ${this.getShaderOptionNumber('cloth_nov_emission_scale_type')}, irradiance);
}

vec3 CalculateMetalFlakeEmission(float refract_bias_x, float refract_bias_y, vec4 irradiance)
{
    float transparent_tex = GetTransparentTexOutput(${this.getShaderOptionNumber('o_transparent_tex')}, refract_bias_x, refract_bias_y).r;
    float metal_flake_power = GetComp(${this.genOutput('o_metal_flake_power')}, ${this.getShaderOptionNumber('metal_flake_power_component')}).x;
    float v = metal_flake_power * log2(CalculateSphereLight());
    vec3 emission_flake = vec3(transparent_tex * exp2(v));
    emission_flake = CalculateEmissionScale(emission_flake, ${this.getShaderOptionNumber('metal_flake_emission_scale_type')}, irradiance);
    vec3 refract_color = ${this.genOutput('o_refract_color')}.rgb;
    return refract_color * emission_flake;
}

struct Light
{
    vec3 I; // eye
    vec3 N; // normal
    vec3 V; // view
    vec3 H; // half
    vec3 L; // light
    vec3 R; // reflect
    float NV; // dot normal view
};

Light SetupLight(vec3 N, vec3 view_pos)
{
    Light light;

    vec3 dir = normalize(view_pos);

    vec3 view_normal = normalize(rotMtx34Vec3(mdlEnvView.cView, N));
    vec3 reflected = reflect(dir, view_normal);
    vec3 cubemap_coords = rotMtx34Vec3(mdlEnvView.cViewInv, reflected);

    light.N = N;
    light.I = rotMtx34Vec3(mdlEnvView.cView, vec3(0,0,1));
    light.V = normalize(light.I); // view
    light.L = normalize(mdlEnvView.cDirLightViewDirFetchPos.xyz ); // light
    light.H = normalize(light.V + light.L); // half angle
    light.R = vec3(cubemap_coords.x, cubemap_coords.y, -cubemap_coords.z); // reflection
    light.NV = saturate(dot(light.N, light.V));

    return light;
}

float CalculateDirectionalLightWrap(vec3 N)
{
    float NV = dot(vec3(N), mdlEnvView.cDirLightViewDirFetchPos.xyz);

    float lighting_factor = clamp(fma(NV, 0.5, 0.5) * fma(NV, 0.5, 0.5) - clamp(NV, 0.0, 1.0), 0.0, 1.0);
    return lighting_factor * clamp(-0.0 + mat.wrap_coef, 0.0, 1.0);
}

vec4 CalculateDiffuseIrradianceLight(Light light)
{
    vec4 irradiance = vec4(0.0, 0.0, 0.0, 1.0);

    //Z seems flipped
    vec3 dir = vec3(light.N.x, light.N.y, -light.N.z);

    // irradiance lighting
    if (${this.getShaderOptionBoolean('is_apply_irradiance_pixel')} == true)
    {
        if (${this.getShaderOptionBoolean('enable_material_light')} == true)
        {
            // Reference: DecodeCubemap(cTextureMaterialLightCube, dir, MAX_LOD).
            // Our CPU binding maps cTextureMaterialLightCube into u_CubemapTexture0 for
            // materials with enable_material_light, so use it directly instead of
            // convolving again.
            vec4 irradiance_cubemap = fetchCubeMapConvertHdr(u_CubemapTexture0, dir, 5.0);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
        else //use material roughness cubemap
        {
            vec4 irradiance_cubemap = fetchCubeMapConvertHdr(u_CubemapTexture0, dir, 5.0);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
        if (${this.getShaderOptionBoolean('enable_material_sphere_light')} == true)
        {
            vec2 sphereCoords = light.N.xy * vec2(0.5) + vec2(0.5, 0.5);
            vec4 sphere_light = textureLod(u_TextureMaterialLightSphere, sphereCoords, 1.0);
            irradiance.rgba += sphere_light.rgba * mdlEnvView.uIrradianceScale;
        }
    }
    else //calculated per vertex
    {
        //By vertex color
        if (${this.getShaderOptionNumber('vtxcolor_type')} == 1) { // VTX_COLOR_TYPE_IRRADIANCE
            irradiance.rgba = v_VtxColor;
        } else { //Calculated in vertex shader
            irradiance.rgba = v_IrradianceVertex.rgba;
        }
    }
    return irradiance;
}

vec3 CalculateBrdf(vec3 view_normal, vec3 dir, float roughness, vec3 f0)
{
    float r = (1.0 - roughness);
    float a = r * r;
    float a2 = a * a;

    float nv = dot(view_normal, -dir);

    float s = clamp(min(a2 * fma(a2, 1.895, -0.1688), 
        fma(nv, fma(nv, fma(nv, -5.069, 8.404), -4.853), 0.9903)) + 0.0, 0.0, 1.0);

    float b = clamp(fma(nv, fma(nv, 0.1939, -0.5228), a2 *
        (fma(a2, fma(a2, 2.661, -3.603), nv * 1.404) + 1.699)) + 0.6045, 0.0, 1.0) - s;

    return f0.rgb * b + s * saturate(f0.g * 50.0);
}

void CalculateIndirectCoordinates()
{
    if (${this.getShaderOptionBoolean('enable_indirect0')} == true)
    {
        vec2 tex_coord_target = SelectTexCoord(${this.getShaderOptionNumber('indirect0_tgt_uv')});
        vec2 ind_map = ${this.genOutput('indirect0_src_map')}.xy;
        vec2 ind_offset = (ind_map - 0.5) * mat.indirect0_scale;
        indirectCoords.xy = tex_coord_target + ind_offset;
    }

    if (${this.getShaderOptionBoolean('enable_indirect1')} == true)
    {
        vec2 tex_coord_target = SelectTexCoord(${this.getShaderOptionNumber('indirect1_tgt_uv')});
        vec2 ind_map = ${this.genOutput('indirect1_src_map')}.xy;
        vec2 ind_offset = (ind_map - 0.5) * mat.indirect1_scale;
        indirectCoords.zw = tex_coord_target + ind_offset;
    }
}

void main() {
    CalculateIndirectCoordinates();
    PrecomputeBlends();

    vec4 base_color_raw       = ${this.genOutput('o_base_color')};
    vec4 base_color           = base_color_raw;
    vec2 normal_map           = ${this.genOutput('o_normal')}.rg;
    float metalness   = GetComp(${this.genOutput('o_metalness')}, ${this.getShaderOptionNumber('metalness_component')}).r;
    float roughness   = GetComp(${this.genOutput('o_roughness')}, ${this.getShaderOptionNumber('roughness_component')}).r;
    vec4 sss                  = ${this.genOutput('o_sss')};
    vec4 ao                   = ${this.genOutput('o_ao')};
    float alpha      = GetComp(${this.genOutput('o_alpha')}, ${this.getShaderOptionNumber('alpha_component')}).w;
    bool has_transparent_tex = ${this.getShaderOptionBoolean('enable_transparent')} && ${this.getShaderOptionNumber('transparent_type')} == 30;

    vec3 eye_to_pos = vec3(v_ViewPos.zw, v_LightColorVPosZ.w);
    vec3 dir = normalize(eye_to_pos);

    vec3 specularTerm = vec3(0.0);
    vec3 light_color = v_LightColorVPosZ.xyz;

    // View tangents
    vec3 view_tangent = vec3(1, 0, 0);
    vec3 view_bitangent = vec3(1, 0, 1);
    // has tangents used
    if (${this.getShaderOptionNumber('o_normal')} != 30) {
        vec3 tangent = vec3(v_Tangents.xyz);
        vec3 bitangent = vec3(v_Tangents.w, v_Bitangents.xy);

        view_tangent = multMtx34Vec3(mdlEnvView.cView, tangent);
        view_bitangent = multMtx34Vec3(mdlEnvView.cView, bitangent);
    }

    //Metalness adjust
    metalness = saturate(metalness);

    //Roughness adjust
    roughness *= mat.force_roughness;
    roughness = saturate(roughness);

    vec3 N = CalculateNormals(v_Normal, normal_map);
    N.x *= modelInfo.normal_axis_x_scale;

    vec3 view_normal = normalize(rotMtx34Vec3(mdlEnvView.cView, N));

    // float t1 = CalculateSphereLight();
    // gl_FragColor = vec4(t1, t1, t1, 1.0);
    // return;

    //Normal to eye
    float N_I = clamp(fma(view_normal.z, -dir.z,
                      fma(view_normal.x,  -dir.x, 
                          view_normal.y * -dir.y)), 0.0, 1.0);

    // Dirt stain
    if (${this.getShaderOptionBoolean('enable_add_stain_proc_texture_3d')} == true)
    {
        vec3 stain_texcoord = v_LocalPos.xyz * mat.stain_uv_scale;
        float stain_intensity = texture(u_TextureProcTexture3D, stain_texcoord).x * mat.stain_rate;
        base_color.rgb = clamp(mix(base_color.rgb, mat.stain_color.rgb, stain_intensity), 0.0, 1.0);
    }

    // refract
    float refract_eta = GetComp(${this.genOutput('o_refract_eta')}, ${this.getShaderOptionNumber('refract_eta_component')}).r;
    float refract_rate = GetComp(${this.genOutput('o_refract_rate')}, ${this.getShaderOptionNumber('refract_rate_component')}).r;

    vec3 refract_view =  refract_eta * -N_I * view_normal + dir * mat.refract_thickness; 

    // refract bias
    float refract_bias_x = dot(refract_view, view_tangent);
    float refract_bias_y = -dot(refract_view, view_bitangent);

    // Cloth
    float cloth_value = 0.0;
    if (${this.getShaderOptionBoolean('enable_cloth_nov')} == true)
    {
        // cloth color/output
        vec4 cloth_map = ${this.genOutput('o_cloth_map')};
        // cloth region to affect
        vec2 cloth_mask = GetComp(${this.genOutput('o_cloth_mask_map')}, ${this.getShaderOptionNumber('cloth_mask_component')}).rg;

        float nov = N_I;

        // float nov = clamp(-dot(view_normal, dir), 0.0, 1.0);
        if (${this.getShaderOptionBoolean('is_cloth_nov_reverse')} == true)
            nov = clamp(1.0 - nov, 0.0, 1.0);

        // peak offset
        float peak_pos = nov - mat.cloth_nov_peak_pos0;
        // tone and peak
        float nov_tone = pow(nov, mat.cloth_nov_tone_pow0); 
        float nov_peak = exp2(peak_pos * 0.0 - peak_pos * mat.cloth_nov_peak_pow0 * 100.0) * mat.cloth_nov_peak_intensity0; 
        // cloth output
        cloth_value = clamp(nov_tone * mat.cloth_nov_slope0 + nov_peak, 0.0, 1.0);
        // apply mask
        cloth_value *= clamp(cloth_mask.x + -0.0, 0.0, 1.0);

        // random noise mask
        if (${this.getShaderOptionBoolean('is_cloth_nov_use_rnd_noise_mask')} == true)
        {
            float noise = sin(fma(cloth_mask.y * mat.cloth_nov_noise_mask_scale0.y,
                78.233, cloth_mask.x * mat.cloth_nov_noise_mask_scale0.y * 12.9898005)) * 43758.5469;

            cloth_value = clamp(fma(cloth_value * (noise - floor(noise) + -0.5), 40.0, cloth_value), 0.0, 1.0);
        }
        // Apply to diffuse
        base_color.rgb = mix(base_color.rgb, cloth_map.rgb, cloth_value);
    }

    if (${this.getShaderOptionBoolean('enable_ao')} == true)
        base_color.rgb *= ao.rgb;

    // Transparency
    if (has_transparent_tex && ${this.getShaderOptionNumber('transparent_tex_type')} == 10) // TRANS_TEX_TYPE_BASE_COLOR
    {
        vec3 refract_color = ${this.genOutput('o_refract_color')}.rgb;
        vec4 transparent_tex = GetTransparentTexOutput(${this.getShaderOptionNumber('o_transparent_tex')}, refract_bias_x, refract_bias_y);

        //refract mix
        base_color.rgb = fma(vec3(refract_rate), fma(transparent_tex.rgb, refract_color, 0.0 - base_color.rgb), base_color.rgb);
    }

    // Lighting
    Light light = SetupLight(N, eye_to_pos);

    // Apply refract rate and reduce diffuse
    base_color.rgb *= vec3(1) - refract_rate;

    // Fresnel
    vec3 f0 = mix(vec3(0.04), base_color.rgb, metalness); // dielectric
    vec3 albedo_color = base_color.rgb * saturate(1.0 - metalness);
    vec3 brdf = CalculateBrdf(view_normal, dir, roughness, f0);

    // Specular GGX
    if (${this.getShaderOptionBoolean('is_use_forward_ggx_specular')} == true)
    {
        vec3 spec_intensity = calcSpecularGGX(roughness, metalness, f0, light.N, light.V, light.L, light.H);
        specularTerm += spec_intensity;
    }

    float spec = metalness * 0.5 + 0.5;
    if (${this.getShaderOptionBoolean('enable_material_light')} == true)
    {
        vec4 spec_cubemap = fetchCubeMapConvertHdr(u_CubemapTexture0, light.R, roughness * 5.0);
        specularTerm.rgb += spec * (spec_cubemap.rgb * mdlEnvView.uIrradianceScale) * brdf;
    }
    else
    {
        vec4 spec_cubemap = fetchCubeMapConvertHdr(u_CubemapTexture0, light.R, roughness * 5.0);
        specularTerm.rgb += spec * (spec_cubemap.rgb * mdlEnvView.uIrradianceScale) * brdf;
    }

    // TODO: enable_structural_color

    if (${this.getShaderOptionBoolean('enable_material_sphere_light')} == true)
    {
        vec2 sphereCoords = light.N.xy * vec2(0.5) + vec2(0.5, 0.5);
        vec4 sphere_light = textureLod(u_TextureMaterialLightSphere, sphereCoords, roughness);
        specularTerm.rgb += spec * (sphere_light.rgb * mdlEnvView.uIrradianceScale) * brdf;
    }

    vec3 diffuseTerm = saturate(base_color.rgb);

    // Irradiance lighting
    vec4 irradiance = CalculateDiffuseIrradianceLight(light);

    diffuseTerm *= saturate(1.0 - metalness);
    diffuseTerm *= vec3(1) - brdf;

    diffuseTerm *= irradiance.rgb;

    float directionalLight = saturate(dot(view_normal, mdlEnvView.cDirLightViewDirFetchPos.xyz)) * (1.0 / PI);
    diffuseTerm += albedo_color * directionalLight * light_color;

    // Base color refract type
    if (${this.getShaderOptionBoolean('enable_transparent')} == true) {
        vec3 refract_amount = refract_rate * (vec3(1) - brdf);
        vec3 refract_color = ${this.genOutput('o_refract_color')}.rgb;

        int transparent_tex_type = ${this.getShaderOptionNumber('transparent_tex_type')};
        
        // TRANS_TEX_TYPE_DIFFUSE || TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
        if ((has_transparent_tex && transparent_tex_type == 15) || transparent_tex_type == 20) {
            vec3 transparent_tex = GetTransparentTexOutput(${this.getShaderOptionNumber('o_transparent_tex')}, refract_bias_x, refract_bias_y).rgb;
            vec3 refract_value = transparent_tex * refract_color * refract_amount;
            if (transparent_tex_type == 20) // TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
                refract_value *= irradiance.rgb;
            diffuseTerm.rgb += refract_value;
        }
        
        int transparent_type = ${this.getShaderOptionNumber('transparent_type')};
        
        // TRANS_TYPE_IND_FBO || TRANS_TYPE_IND_FBO_DEPTH
        if (transparent_type == 20 || transparent_type == 25) {
            vec2 ind_coords = refract_eta * -N_I * view_normal.xy;
            
            vec2 view_diff = GetResolvedTextureCoordinates() + ind_coords;
            
            if (${this.getShaderOptionBoolean('enable_indirect_dist_correct')} == true) {
                // calcIndirectDistCorrect
                // TODO: ice UV issue at close distances
                float base_depth = texture(u_TextureLinearDepth, GetResolvedTextureCoordinates()).x;
                float diff_depth = -abs(v_Depth - base_depth);
                diff_depth = clamp01(1.0 - exp2(diff_depth * mat.indirect_depth_scale));
                view_diff = GetResolvedTextureCoordinates() + ind_coords * diff_depth;
            }
        
            if (transparent_type == 25) { // TRANS_TYPE_IND_FBO_DEPTH
                if (texture(u_TextureLinearDepth, view_diff).x < v_Depth) 
                    view_diff = GetResolvedTextureCoordinates();
            }
        
            vec4 fbo = texture(u_FrameBufferTexture, view_diff);
            diffuseTerm.rgb += refract_amount * fbo.rgb * refract_color.rgb;
        }
    }

    if (${this.getShaderOptionBoolean('enable_alphamask')} == true) {
        int alpha_test_func = ${this.getShaderOptionNumber('alpha_test_func')};
        if (alpha_test_func == 0) {
            discard;
        }
        else if (alpha_test_func == 10) {
            if (alpha >= mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 20) {
            if (alpha != mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 30) {
            if (alpha > mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 40) {
            if (alpha <= mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 50) {
            if (alpha == mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 60) {
            if (alpha < mat.alpha_test_value)
                discard;
        }
    }

    vec4 light_buf = vec4(0.0);
    vec3 additiveTerm = vec3(0.0);

    // Light output diffuse + specular
    light_buf.rgb = diffuseTerm + specularTerm;

    float output_alpha = alpha * modelInfo.model_alpha_mask;
#ifdef OPT_PREMULTIPLIED_ALPHA_BLEND
    light_buf.rgb *= max(output_alpha, 0.0);
    light_buf.a = clamp01(output_alpha);
#else
    light_buf.a = output_alpha;
#endif

    // Cloth Emission
    if (${this.getShaderOptionBoolean('enable_cloth_nov')} == true)
        additiveTerm += CalculateClothEmission(irradiance) * cloth_value;

    // Emission
    if (${this.getShaderOptionBoolean('enable_emission')} == true)
        additiveTerm += CalculateEmission(irradiance).rgb;

    // Metal flake emission
    if (has_transparent_tex && ${this.getShaderOptionNumber('transparent_tex_type')} == 25)
        additiveTerm += CalculateMetalFlakeEmission(refract_bias_x, refract_bias_y, irradiance);

    if (${this.getShaderOptionBoolean('enable_sss')} == true)
    {
        float light_intensity = CalculateDirectionalLightWrap(view_normal);
        additiveTerm += light_color.xyz * diffuseTerm.rgb * light_intensity * sss.r * (1.0 / PI);
    }
    
    light_buf.rgb += additiveTerm;

    // TODO: if enable_translucent, adjust for shadows

    // clamp 0 - 2048 due to HDR/tone mapping
    light_buf.rgb = max(light_buf.rgb, 0.0);
    light_buf.rgb = min(light_buf.rgb, 2048.0);

    if (mdlEnvView.cIsDeferredFog < 0.5)
        light_buf.rgb = CalculateFog(light_buf.rgb, eye_to_pos, v_WorldPos);

#ifdef OPT_RIPPLE_MATERIAL
    // InitRippleParam replacement materials are drawn with RGB replace / alpha preserve
    // Empty ripple texels must not replace the opaque scene with black
    if (max(max(light_buf.r, light_buf.g), light_buf.b) < 0.001)
        discard;
#endif
#ifdef OPT_ADDITIVE_XLU
    gl_FragColor = vec4(light_buf.rgb, 0.0);
#else
    gl_FragColor = vec4(light_buf.rgb, light_buf.a);
#endif
}
`;

this.vert = `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;
layout(location = 5) in vec2 _u1;
layout(location = 6) in vec2 _u2;
layout(location = 7) in vec2 _u3;

out vec3 v_Normal;
out vec3 v_WorldPos;
out vec3 v_LocalPos;
out float v_Depth;
out vec4 v_Tangents;
out vec4 v_Bitangents;
out vec4 v_ViewPos;
out vec4 v_LightColorVPosZ;
out vec2 v_TexCoord0;
out vec2 v_TexCoord1;
out vec2 v_TexCoord2;
out vec2 v_TexCoord3;
out vec4 v_VtxColor;
out vec4 v_IrradianceVertex;
out vec2 v_SphereCoords;
out vec4 v_PerspDiv;
out vec4 v_IndirectCoords;

vec2 calc_texcoord_matrix(mat2x4 mtx, vec2 tex_coord) {
    vec3 r0 = vec3(mtx[0].xyz);
    vec3 r1 = vec3(mtx[0].w, mtx[1].xy);
    vec3 uv1 = vec3(tex_coord, 1.0);
    return vec2(dot(uv1, r0), dot(uv1, r1));
}

vec2 get_tex_mtx(vec2 tex_coord, int type) {
    if (type == 1)
        return calc_texcoord_matrix(mat.tex_mtx0, tex_coord);
    else if (type == 2)
        return calc_texcoord_matrix(mat.tex_mtx1, tex_coord);
    else if (type == 3)
        return calc_texcoord_matrix(mat.tex_mtx2, tex_coord);
    else if (type == 4)
        return calc_texcoord_matrix(mat.tex_mtx3, tex_coord);
    else
        return tex_coord;
}

vec2 get_tex_coord(int selector, int mtx_type, bool enable) {
    if (!enable)
        return _u0;

    if (selector == 1)
        return get_tex_mtx(_u1, mtx_type);
    else if (selector == 2)
        return get_tex_mtx(_u2, mtx_type);
    else if (selector == 3)
        return get_tex_mtx(_u3, mtx_type);
    else
        return get_tex_mtx(_u0, mtx_type);
}

void main() {
    // World space position
    vec3 worldPos = UnpackMatrix(u_Model) * vec4(_p0, 1.0);

    // View space position
    vec3 viewPos = UnpackMatrix(u_View) * vec4(worldPos, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * vec4(viewPos, 1.0);

    v_ViewPos = vec4(0.0, 0.0, viewPos.xy);
    v_WorldPos = worldPos;
    v_LocalPos = _p0;
    v_Depth = (gl_Position.w - mdlEnvView.cNear) * mdlEnvView.cInvRange;

    // World space normal
    v_Normal = normalize((UnpackMatrix(u_Model) * vec4(_n0.xyz, 0.0)).xyz);

    v_TexCoord0 = get_tex_coord(${this.getShaderOptionNumber('fuv0_selector')}, ${this.getShaderOptionNumber('fuv0_mtx')}, ${this.getShaderOptionBoolean('enable_fuv0')});
    v_TexCoord1 = get_tex_coord(${this.getShaderOptionNumber('fuv1_selector')}, ${this.getShaderOptionNumber('fuv1_mtx')}, ${this.getShaderOptionBoolean('enable_fuv1')});
    v_TexCoord2 = get_tex_coord(${this.getShaderOptionNumber('fuv2_selector')}, ${this.getShaderOptionNumber('fuv2_mtx')}, ${this.getShaderOptionBoolean('enable_fuv2')});
    v_TexCoord3 = get_tex_coord(${this.getShaderOptionNumber('fuv3_selector')}, ${this.getShaderOptionNumber('fuv3_mtx')}, ${this.getShaderOptionBoolean('enable_fuv3')});
    v_VtxColor = _c0;

    v_LightColorVPosZ.w = viewPos.z;

    vec3 light_color = textureLod(u_DirectionalLightLUT, vec2(mdlEnvView.cDirLightViewDirFetchPos.w, 0.5), 0.0).xyz;
    v_LightColorVPosZ.xyz = light_color;
   
    if (${this.getShaderOptionBoolean('is_apply_irradiance_pixel')} == false)
    {
        if (${this.getShaderOptionBoolean('enable_material_light')}) // use material light cubemap
        {
            vec4 irradiance_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, vec3(v_Normal.x, v_Normal.y, -v_Normal.z));
            v_IrradianceVertex = irradiance_cubemap *= mdlEnvView.uIrradianceScale;
        }
        else //use material roughness cubemap
        {
            vec4 irradiance_cubemap = fetchCubeMapConvertHdr(u_CubemapTexture0, vec3(v_Normal.x, v_Normal.y, -v_Normal.z), 5.0);
            v_IrradianceVertex.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
    }

    // TODO: enable_motion_vec

    // Sphere mapping coordinates
    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, v_Normal));
    v_SphereCoords = view_normal.xy * 0.5 + 0.5;

    // moved to fragment shader due to distortion
    // v_PerspDiv.xy = gl_Position.xy / gl_Position.w;

    vec3 T = normalize((UnpackMatrix(u_Model) * vec4(_t0.xyz, 0.0)).xyz);
    v_Tangents = vec4(T, 0.0);
    
    // bitangent
    vec3 B = normalize(cross(v_Normal, T) * _t0.w);
    v_Tangents.w = B.x;
    v_Bitangents.x = B.y;
    v_Bitangents.y = B.z;
}
`;

}}
