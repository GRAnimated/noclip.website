import { FMAT } from "../../fres_nx/bfres.js";
import { MaterialUniforms, OdysseyProgram, ubMdlEnvView, ubModelAdditionalInfo, ubShapeParams } from "../OdysseyProgram.js";

export class RenderCloudLayer extends OdysseyProgram {
    public isTranslucent: boolean = true;

    constructor(fmat: FMAT) {
        super(fmat);

        this.isTranslucent = true;

        this.both += `
${ubShapeParams}
${ubMdlEnvView}
layout(std140) uniform ub_CloudMaterial {
    float uPhaseK;
    float uPhaseKBack;
    float uIsoRate;
    float uDiffuseScatterRatePow;
    vec2 WrapCoef;
    vec2 cIndirectScale;
    vec4 albedo;
    mat2x4 cTexMtxAlbedo0;
    mat2x4 cTexMtxNormal0;
    mat2x4 cTexMtxIndirect0;
    mat2x4 cTexMtxIndirect1;
} cloudMat;
${ubModelAdditionalInfo}
${MaterialUniforms}

void CalcLdrToHdr(out vec4 hdr, vec4 ldr) {
    float scale = pow(ldr.a, mdlEnvView.HDRTranslate_uHDRPower) * mdlEnvView.HDRTranslate_uDynamicRange;
    hdr = vec4(ldr.rgb * scale, scale);
}

float calcPhaseFunctionSchlick(float k, float cosTheta) {
    float tmp = 1.0 - k * cosTheta; // k > 0 => forward scatter, matching alMathUtil.glsl.
    return (1.0 - k*k) / (4.0 * PI * tmp * tmp);
}

float calcScatterPhaseFunctionSchlick(float kf, float kb, float fbRate, float cosTheta) {
    float fs = calcPhaseFunctionSchlick(kf, cosTheta);
    float bs = calcPhaseFunctionSchlick(-kb, cosTheta);
    return mix(fs, bs, fbRate);
}

float calcWrapDiffuse(vec3 nrm, vec3 toLight, vec2 wrapCoef) {
    float N_L = dot(nrm, toLight);
    return clamp01((N_L + wrapCoef.x) * wrapCoef.y) * INV_PI;
}

vec2 calcCloudTexcoordMatrix(mat2x4 mtx, vec2 texCoord) {
    vec3 r0 = vec3(mtx[0].xyz);
    vec3 r1 = vec3(mtx[0].w, mtx[1].xy);
    vec3 uv1 = vec3(texCoord, 1.0);
    return vec2(dot(uv1, r0), dot(uv1, r1));
}

vec3 reconstructNormal(vec2 texNormal) {
    vec3 localNormal;
    localNormal.xy = texNormal * 2.0 - 1.0;
    localNormal.z = sqrt(max(0.0, 1.0 - dot(localNormal.xy, localNormal.xy)));
    return localNormal;
}
`;

this.vert = `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;
layout(location = 5) in vec2 _u1;

out vec3 v_NormalWorld;
out vec3 v_NormalView;
out vec4 v_TangentsWorld;
out vec4 v_BitangentsWorld;
out vec4 v_ViewPos;
out vec2 v_TexCoord0;
out vec4 v_VtxColor;
out vec4 v_LightColor;
out vec4 v_Irradiance;

void main() {
    vec3 worldPos = UnpackMatrix(u_Model) * vec4(_p0, 1.0);
    vec3 viewPos = multMtx34Vec3(mdlEnvView.cView, worldPos);

    gl_Position = UnpackMatrix(u_Projection) * vec4(viewPos, 1.0);

    v_ViewPos = vec4(viewPos, 1.0);
    v_TexCoord0 = _u0;
    v_VtxColor = _c0;

    v_NormalWorld = normalize((UnpackMatrix(u_Model) * vec4(_n0.xyz, 0.0)).xyz);
    v_NormalView = normalize(rotMtx34Vec3(mdlEnvView.cView, v_NormalWorld));

    vec3 tangent = normalize((UnpackMatrix(u_Model) * vec4(_t0.xyz, 0.0)).xyz);
    v_TangentsWorld = vec4(tangent, _t0.w);

    vec3 bitangent = normalize(cross(v_NormalWorld, tangent) * _t0.w);
    v_BitangentsWorld = vec4(bitangent, 1.0);

    v_LightColor = textureLod(u_DirectionalLightLUT, vec2(mdlEnvView.cDirLightViewDirFetchPos.w, 0.5), 0.0);

    vec3 irradianceDir = vec3(v_NormalWorld.x, v_NormalWorld.y, -v_NormalWorld.z);
    v_Irradiance = fetchCubeMapIrradianceConvertHdr(u_CubemapTexture0, irradianceDir) * mdlEnvView.uIrradianceScale;
}
`;

this.frag = `
in vec3 v_NormalWorld;
in vec3 v_NormalView;
in vec4 v_TangentsWorld;
in vec4 v_BitangentsWorld;
in vec4 v_ViewPos;
in vec2 v_TexCoord0;
in vec4 v_VtxColor;
in vec4 v_LightColor;
in vec4 v_Irradiance;

void main() {
    vec2 indirectUV0 = calcCloudTexcoordMatrix(cloudMat.cTexMtxIndirect0, v_TexCoord0);
    vec2 indirectUV1 = calcCloudTexcoordMatrix(cloudMat.cTexMtxIndirect1, v_TexCoord0);
    vec2 indirect0 = texture(u_Texture2, indirectUV0).rg * 2.0 - 1.0;
    vec2 indirect1 = texture(u_Texture3, indirectUV1).rg * 2.0 - 1.0;
    vec2 indirectOffset = indirect0 * cloudMat.cIndirectScale.x + indirect1 * cloudMat.cIndirectScale.y;

    vec2 albedoUV = calcCloudTexcoordMatrix(cloudMat.cTexMtxAlbedo0, v_TexCoord0) + indirectOffset;
    vec2 normalUV = calcCloudTexcoordMatrix(cloudMat.cTexMtxNormal0, v_TexCoord0) + indirectOffset;

    vec4 albedoSample = texture(u_Texture0, albedoUV);
    vec4 normalSample = texture(u_Texture1, normalUV);
    float density = albedoSample.a;

    vec3 Nw = normalize(v_NormalWorld);
    vec3 T = normalize(v_TangentsWorld.xyz);
    vec3 B = normalize(v_BitangentsWorld.xyz);
    mat3 TBN = mat3(T, B, Nw);
    vec3 tangentNormal = normalize(mix(vec3(0.0, 0.0, 1.0), reconstructNormal(normalSample.rg), 0.25));
    Nw = normalize(TBN * tangentNormal);
    vec3 Nv = normalize(rotMtx34Vec3(mdlEnvView.cView, Nw));

    vec3 V = normalize(-v_ViewPos.xyz);
    vec3 L = normalize(mdlEnvView.cDirLightViewDirFetchPos.xyz);
    vec3 litToPos = -L;
    float cosTheta = dot(litToPos, V);

    float phase = calcScatterPhaseFunctionSchlick(cloudMat.uPhaseK, cloudMat.uPhaseKBack, cloudMat.uIsoRate, cosTheta);
    float diffuse = calcWrapDiffuse(Nv, L, cloudMat.WrapCoef);

    vec3 baseColor = cloudMat.albedo.rgb;
    float alpha = density * cloudMat.albedo.a;

    alpha *= 1.0 - smoothstep(0.70, 1.0, v_TexCoord0.y);

    if (${this.getShaderOptionBoolean('cIsMultVertexColor')}) {
        baseColor *= v_VtxColor.rgb;
    }
    alpha *= v_VtxColor.a;

    vec3 irradiance = v_Irradiance.rgb;
    if (${this.getShaderOptionBoolean('cIsEnableSphereLight')}) {
        vec2 sphereCoords = Nv.xy * vec2(0.5) + vec2(0.5);
        irradiance += textureLod(u_TextureMaterialLightSphere, sphereCoords, 1.0).rgb * mdlEnvView.uIrradianceScale;
    }

    vec3 direct = v_LightColor.rgb * (diffuse + phase * cloudMat.uDiffuseScatterRatePow);

    vec3 finalRGB = baseColor * max(irradiance + direct, vec3(0.75));

    gl_FragColor = vec4(finalRGB, alpha * modelInfo.model_alpha_mask);
}
`;
    }
}
