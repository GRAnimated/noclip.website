import { FMAT } from "../../fres_nx/bfres.js";
import { assert } from "../../util.js";
import { OdysseyProgram } from "../OdysseyProgram.js";
import { generateFogCode } from "./FogUtil.js";
import { generateShaderUtil } from "./ShaderUtil.js";

export class RenderMaterial extends OdysseyProgram {
    public isTranslucent: boolean = false;

    constructor(fmat: FMAT) {
        super(fmat);

        assert(this.fmat.samplerInfo.length <= 8);

        if (this.getShaderOptionNumber('vtxcolor_type') >= 0)
            this.defines.set('OPT_vtxcolor', '1');

        let alphaIsTranslucent = false;
        try {
            alphaIsTranslucent = this.outputIsTranslucent('o_alpha');
        } catch (e) {}

        this.isTranslucent = alphaIsTranslucent && !this.getShaderOptionBoolean(`enable_alphamask`);

this.both += `
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

vec4 fetchCubeMap(samplerCube cube, vec3 dir, float bias) {
    vec4 tex = textureLod(cube, dir, bias);
    return tex;
}

vec4 fetchCubeMapConvertHdr(samplerCube cube, vec3 dir, float bias) {
    vec4 tex = textureLod(cube, dir, bias);

    CalcLdrToHdr(tex, tex);
    return tex;
}

vec4 fetchCubeMapIrradiance(samplerCube cube, vec3 dir) {
    vec4 tex = textureLod(cube, dir, 5.0);
    return tex;
}

vec4 fetchCubeMapIrradianceConvertHdr(samplerCube cube, vec3 dir) {
    vec4 tex = textureLod(cube, dir, 5.0);

    CalcLdrToHdr(tex, tex);
    return tex;
}
`;

this.frag = `
in vec3 v_Normal;
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

${ generateFogCode() }

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
        return v_IrradianceVertex.xy; // is this right?
    else if  (mtx_select == 21) //indirect coord 1
        return v_IrradianceVertex.zw; // same here
    else if  (mtx_select == 30) //sphere mapping
        return v_SphereCoords.xy;
    else //TODO 50 - 54 are proj texture types
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
    if (enable) //Todo third argument uses MdlEnvView.data[0x12A].x, a global LOD value
        uniform_output = texture(cTexture, SelectTexCoord(uv_selector) + tex_bias);
    if (enable_roughness_lod)
        uniform_output = textureLod(cTexture, SelectTexCoord(uv_selector), 0.0);
    if (enable_mul_color)
        uniform_output *= mul_color;
    if (enable_mul_vtx_color)
        uniform_output *= v_VtxColor;

    return uniform_output;
}

vec3 calcSpecularGGX(float roughness, vec3 f0, vec3 N, vec3 V, vec3 L, vec3 H)
{
	float N_H = saturate(dot(N, H));
	float L_H = saturate(dot(L, H));
	float N_V = saturate(dot(N, V));
	float N_L = saturate(dot(N, L));

    // Distribution term (D)
    float alpha = roughness * roughness;
    float alpha_2 = alpha * alpha;
    float denom = N_H * N_H * (alpha_2 - 1.0) + 1.0;
    float pi_denom_2 = PI * denom * denom;
    float D = alpha_2 / max(pi_denom_2, 0.0005);

    // Fresnel term (F)
    float dotLH5 = pow(1.0 - L_H, 5.0);
    float F_a = 1.0;
    float F_b = dotLH5;
    
    // Visibility/Geometry term (V)
    float k = alpha * 0.5;
    float k2 = k * k;
    float invK2 = 1.0 - k2;
    float vis_numerator = abs(N_V) * N_L;
    float vis = vis_numerator / (L_H * L_H * invK2 + k2);
    
    // Combine F and V
    vec2 FV_helper;
    FV_helper.x = (F_a - F_b) * vis;
    FV_helper.y = F_b * vis;
    vec3 FV = f0 * FV_helper.x + FV_helper.y;
    
    // Final specular with cavity coefficient approximation
    float spc_cavity_coef = mix(1.0 - roughness * roughness, 1.0, 0.0) * 0.5; // metalness would go here
    return FV * (N_L * D * spc_cavity_coef);
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

    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, vertex_normal.xyz));
    vec3 view_pos = vec3(v_ViewPos.zw, v_LightColorVPosZ.w);

    vec3 dir = normalize(view_pos);

    return clamp(fma(dir.z, -view_normal.z,
                    fma(dir.x, -view_normal.x, 
                    dir.y * -view_normal.y)), 0.0, 1.0);
}

vec4 CalculateSphereConstColor(int sphere_color_type, vec4 const_color, float sphere_rate_color) {
    float cosTheta  = CalculateSphereLight();

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

vec4 CalculateProcTexture2D() {
    // TODO: stub
    return vec4(1.0, 1.0, 1.0, 1.0);
}

vec4 CalculateProcTexture3D() {
    // TODO: stub
    return vec4(1.0, 1.0, 1.0, 1.0);
}

vec4 CalculateBaseColor(vec2 tex_bias)
{
    vec4 basecolor_output = vec4(1.0);
    if (${this.getShaderOptionBoolean('enable_base_color')}) //Todo third argument uses MdlEnvView.data[0x12A].x, a global LOD value
        basecolor_output = (${this.genSample("_a0", this.selectTexCoord(this.getShaderOptionNumber('base_color_fuv_selector')), ' + tex_bias')});
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

vec4 CalculateOutput(int flag)
{
    if (flag == 10) return CalculateBaseColor(vec2(0.0));
    else if (flag == 15) return v_VtxColor;
    else if (flag == 20) {
        // Normal map
        return texture(u_Texture1, ${this.selectTexCoord(this.getShaderOptionNumber('normal_fuv_selector'))});
    }
    else if (flag == 30) return vec4(GetWorldNormal().xyz, 0.0); // World Normal

    else if (flag == 50) return ${this.genUniform(0)};
    else if (flag == 51) return ${this.genUniform(1)};
    else if (flag == 52) return ${this.genUniform(2)};
    else if (flag == 53) return ${this.genUniform(3)};
    else if (flag == 54) return ${this.genUniform(4)};
    else if (flag == 60) return mat.const_color0;
    else if (flag == 61) return mat.const_color1;
    else if (flag == 62) return mat.const_color2;
    else if (flag == 63) return mat.const_color3;

    else if (flag == 70) return texture(u_Texture0, v_TexCoord0); // FB sampler TODO
    else if (flag == 78) return texture(u_Texture1, v_TexCoord0); // Depth sampler TODO

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

    return vec4(1.0, 0.0, 1.0, 1.0);
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

    else if (flag == 60) return CalculateSphereConstColor(0, mat.const_color0, mat.sphere_rate_color0);
    else if (flag == 61) return CalculateSphereConstColor(1, mat.const_color1, mat.sphere_rate_color1);
    else if (flag == 62) return CalculateSphereConstColor(2, mat.const_color2, mat.sphere_rate_color2);
    else if (flag == 63) return CalculateSphereConstColor(3, mat.const_color3, mat.sphere_rate_color3);

    else if (flag == 115) return vec4(0.0);
    else if (flag == 116) return vec4(1.0);

    return vec4(0.0);
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
    BLEND5_OUTPUT = CalculateBlend(enable_blend, blend_src, blend_dst, blend_cof, blend_cof_map, blend_src_ch, blend_dst_ch, blend_cof_ch, blend_eq);
}

vec3 CalculateEmissionScale(vec3 emission, int scale_type, vec4 irradiance)
{
    //Emission scale
    if      (scale_type == 1) // emission * irradiance, max by emission
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
        // TODO: Need exposure texture 
        // float exposure = texture(cExposureTexture, vec2(0.0, 0.0)).a;
        // emission *= 1.0 / exposure * mdlEnvView.Exposure.x;
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
            vec4 irradiance_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, dir);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
        else //use material roughness cubemap
        {
            // TODO: and TEMP: Roughness cubemap
            vec4 irradiance_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, dir);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
        if (${this.getShaderOptionBoolean('enable_material_sphere_light')} == true)
        {
	        vec2 sphereCoords = light.N.xy * vec2(0.5) + vec2(0.5, 0.5);
            vec3 sphereCoords3 = vec3(sphereCoords, 0.0);
            vec4 sphere_light = textureLod(u_CubemapTexture0, sphereCoords3, 1.0);
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

vec2 GetScreenCoordinates()
{
	vec2 screenCoord = v_PerspDiv.xy * 0.5 + 0.5;
    screenCoord.y = 1.0 - screenCoord.y;
    return screenCoord;
}

void main() {
    PrecomputeBlends();

    vec4 base_color           = ${this.genOutput('o_base_color')};
    vec2 normal_map           = ${this.genOutput('o_normal')}.rg;
    float metalness   = GetComp(${this.genOutput('o_metalness')}, ${this.getShaderOptionNumber('metalness_component')}).r;
    float roughness   = GetComp(${this.genOutput('o_roughness')}, ${this.getShaderOptionNumber('roughness_component')}).r;
    vec4 sss                  = ${this.genOutput('o_sss')};
    vec4 ao                   = ${this.genOutput('o_ao')};
    float alpha      = GetComp(${this.genOutput('o_alpha')}, ${this.getShaderOptionNumber('alpha_component')}).r;
    bool has_transparent_tex = ${this.getShaderOptionBoolean('enable_transparent')};

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

    vec3 vertex_normal = v_Normal;

    vec3 N = CalculateNormals(v_Normal, normal_map);
    N.x *= modelInfo.normal_axis_x_scale;

    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, N).xyz);

    //Normal to eye
    float N_I = clamp(fma(view_normal.z, -dir.z,
                      fma(view_normal.x,  -dir.x, 
                          view_normal.y * -dir.y)), 0.0, 1.0);

    // TODO: Dirt stain

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
    vec3 f0 = mix(vec3(0.04), base_color.rgb, metalness); // dialectric
    vec3 brdf = CalculateBrdf(view_normal, dir, roughness, f0);

    // Specular GGX
    if (${this.getShaderOptionBoolean('is_use_forward_ggx_specular')} == true)
    {
        vec3 spec_intensity = calcSpecularGGX(roughness, f0, light.N, light.V, light.L, light.H);
        specularTerm += spec_intensity;
    }

    float spec = metalness * 0.5 + 0.5;
    //use material light cubemap
    if (${this.getShaderOptionBoolean('enable_material_light')} == true)
    {
        vec4 spec_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, light.R);
        specularTerm.rgb += spec * (spec_cubemap.rgb * mdlEnvView.uIrradianceScale) * brdf;
    }
    else
    {
        // TODO: and TEMP: Roughness cubemap
        vec4 spec_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, light.R);
        specularTerm.rgb += spec * (spec_cubemap.rgb * mdlEnvView.uIrradianceScale) * brdf;
    }

    // TODO: enable_structural_color

    // TODO: enable_material_sphere_light

    // Diffuse
    vec3 diffuseTerm = saturate(base_color.rgb);

    // Irradiance lighting
    vec4 irradiance = CalculateDiffuseIrradianceLight(light);

    // Adjust for metalness
    diffuseTerm *= saturate(1.0 - metalness);
    diffuseTerm *= vec3(1) - brdf;

    diffuseTerm *= irradiance.rgb;

    // Directional light
    float directionalLight = saturate(dot(N, mdlEnvView.cDirLightViewDirFetchPos.xyz)) * INV_PI;
    diffuseTerm += base_color.rgb * saturate(1.0 - metalness) * directionalLight * light_color;

    // Base color refract type
    if (${this.getShaderOptionBoolean('enable_transparent')} == true){
        vec3 refract_amount = refract_rate * (vec3(1) - brdf);
        vec3 refract_color = ${this.genOutput('o_refract_color')}.rgb;

        int transparent_tex_type = ${this.getShaderOptionNumber('transparent_tex_type')};
        
        // TRANS_TEX_TYPE_DIFFUSE || TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
        if (has_transparent_tex && (transparent_tex_type == 15 || transparent_tex_type == 20))
        {
            // TODO: Need GetTransparentTexOutput function
            // vec3 transparent_tex = GetTransparentTexOutput(${this.genOutput('o_transparent_tex')}, refract_bias_x, refract_bias_y).rgb;
            // vec3 refract_value = transparent_tex * refract_color * refract_amount;
            // if (transparent_tex_type == 20) // TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
            //     refract_value *= irradiance.rgb;
            // diffuseTerm.rgb += refract_value;
        }
        
        int transparent_type = ${this.getShaderOptionNumber('transparent_type')};
        
        // TRANS_TYPE_IND_FBO || TRANS_TYPE_IND_FBO_DEPTH
        if (transparent_type == 20 || transparent_type == 25)
        {
            vec2 ind_coords = refract_eta * -N_I * view_normal.xy;
            
            vec2 coords = GetScreenCoordinates() + ind_coords;
            
            // if (${this.getShaderOptionBoolean('enable_indirect_dist_correct')} == true)
            // {
            //     // TODO: Need cTextureLinearDepth
            //     // float d = -abs(v_Normal.w - texture(cTextureLinearDepth, coords).x) * mat.indirect_depth_scale;
            //     // d = saturate(1.0 - exp2(d));
            //     // coords = GetScreenCoordinates() + ind_coords * d;
            // }
            
            // if (transparent_type == 25) // TRANS_TYPE_IND_FBO_DEPTH
            // {
            //     // TODO: Need cTextureLinearDepth
            //     // if (texture(cTextureLinearDepth, coords).x < v_Normal.w) 
            //     //     coords = GetScreenCoordinates();
            // }
            
            // TODO: Need cFrameBufferTex
            // vec4 fbo = texture(cFrameBufferTex, coords);
            // diffuseTerm.rgb += refract_amount * fbo.rgb * refract_color.rgb;
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

    // Light output diffuse + specular
    light_buf.rgb = diffuseTerm + specularTerm;
    light_buf.a = alpha;

    // TODO: Cloth Emission

    // Emission
    if (${this.getShaderOptionBoolean('enable_emission')} == true)
        light_buf.rgb += CalculateEmission(irradiance).rgb;
    
    // TODO: metal flake emission

    if (${this.getShaderOptionBoolean('enable_sss')} == true)
    {
        float light_intensity = CalculateDirectionalLightWrap(view_normal);
        light_buf.rgb += light_color.xyz * diffuseTerm.rgb * light_intensity * sss.r * (1.0 / PI);
    }

    // TODO: if enable_translucent, adjust for shadows

    // clamp 0 - 2048 due to HDR/tone mapping
    light_buf.rgb = max(light_buf.rgb, 0.0);
    light_buf.rgb = min(light_buf.rgb, 2048.0);

    light_buf.rgb = CalculateFog(light_buf.rgb, eye_to_pos);

    gl_FragColor = vec4(light_buf.rgb, light_buf.a);

    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(mdlEnvView.HDRTranslate_uHDRPower / mdlEnvView.HDRTranslate_uDynamicRange));
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

void main() {
    vec3 t_PositionView = UnpackMatrix(u_ModelView) * vec4(_p0, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * vec4(t_PositionView, 1.0);
    
    v_TexCoord0 = _u0;
    v_TexCoord1 = _u1;
    v_TexCoord2 = _u2;
    v_TexCoord3 = _u3;
    v_VtxColor = _c0;

    v_ViewPos.zw = t_PositionView.xy;
    v_LightColorVPosZ.w = t_PositionView.z;

    vec3 light_color = textureLod(u_DirectionalLightLUT, vec2(mdlEnvView.cDirLightViewDirFetchPos.w, 0.5), 0.0).xyz;
    
    // temp
    light_color *= 5.0;

    v_LightColorVPosZ.xyz = light_color;
   
    if (${this.getShaderOptionBoolean('is_apply_irradiance_pixel')} == false)
    {
        if (${this.getShaderOptionBoolean('enable_material_light')}) // use material light cubemap
        {
            vec4 irradiance_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, v_Normal);
            v_IrradianceVertex = irradiance_cubemap *= mdlEnvView.uIrradianceScale;
        }
        else //use material roughness cubemap
        {
            // TODO: and TEMP: Roughness cubemap
            vec4 irradiance_cubemap = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, v_Normal);
            v_IrradianceVertex.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
        }
    }

    // TODO: enable_motion_vec

    // TODO: Check if any proj textures are used

    // Sphere mapping coordinates
    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, v_Normal));
    v_SphereCoords = view_normal.xy * 0.5 + 0.5;

    v_PerspDiv.xy = gl_Position.xy / gl_Position.w;

    v_Normal = _n0.xyz;
    v_Tangents = _t0;
    
    // bitangent
    vec3 B = normalize(cross(v_Normal, _t0.xyz) * _t0.w);
    v_Tangents.w = B.x;
    v_Bitangents.x = B.y;
    v_Bitangents.y = B.z;
}
`;

}}
