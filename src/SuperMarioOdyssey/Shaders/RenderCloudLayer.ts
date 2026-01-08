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

// Henyey-Greenstein Phase Function
float PhaseHG(float g, float cosTheta) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}
`;

this.vert = `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;
layout(location = 5) in vec2 _u1; 

out vec3 v_Normal;
out vec4 v_Tangents;
out vec4 v_Bitangents;
out vec4 v_ViewPos;
out vec2 v_TexCoord0;
out vec4 v_VtxColor;

void main() {
    vec3 worldPos  = UnpackMatrix(u_Model) * vec4(_p0, 1.0);

    vec3 viewPos = multMtx34Vec3(mdlEnvView.cView, worldPos);
    
    gl_Position = UnpackMatrix(u_Projection) * vec4(viewPos, 1.0);

    v_ViewPos = vec4(viewPos, 1.0);
    v_TexCoord0 = _u0;
    v_VtxColor = _c0;

    v_Normal = normalize((UnpackMatrix(u_Model) * vec4(_n0.xyz, 0.0)).xyz);

    vec3 tangent = normalize((UnpackMatrix(u_Model) * vec4(_t0.xyz, 0.0)).xyz);
    v_Tangents.xyz = tangent;
    v_Tangents.w = _t0.w;

    vec3 bitangent = normalize(cross(v_Normal, tangent) * _t0.w);
    v_Bitangents = vec4(bitangent, 1.0);
}
`;

this.frag = `
in vec3 v_Normal;
in vec4 v_Tangents;
in vec4 v_Bitangents;
in vec4 v_ViewPos;
in vec2 v_TexCoord0;
in vec4 v_VtxColor;

vec3 ReconstructNormal(vec2 texNormal) {
    vec3 localNormal;
    localNormal.xy = texNormal * 2.0 - 1.0;
    localNormal.z = sqrt(max(0.0, 1.0 - dot(localNormal.xy, localNormal.xy)));
    return localNormal;
}

void main() {
    vec3 V = normalize(-v_ViewPos.xyz);
    vec3 L = normalize(mdlEnvView.cDirLightViewDirFetchPos.xyz);

    float densitySample = texture(u_Texture0, v_TexCoord0).r;
    vec4 normalSample = texture(u_Texture1, v_TexCoord0);
    
    vec3 N = normalize(v_Normal);
    vec3 T = normalize(v_Tangents.xyz);
    vec3 B = normalize(v_Bitangents.xyz);
    mat3 TBN = mat3(T, B, N);
    
    vec3 tangentNormal = ReconstructNormal(normalSample.rg);
    N = normalize(TBN * tangentNormal);

    float cosTheta = dot(L, V);

    float pForward = PhaseHG(cloudMat.uPhaseK, cosTheta);
    float pBack    = PhaseHG(-cloudMat.uPhaseKBack, cosTheta);
    
    float phase = mix(pForward, pBack, 0.5);
    
    phase = mix(phase, INV_PI * 0.25, cloudMat.uIsoRate);

    float wrap = cloudMat.WrapCoef.x;
    float NdotL = dot(N, L);
    float diffuse = max(0.0, (NdotL + wrap) / (1.0 + wrap));

    diffuse *= cloudMat.uDiffuseScatterRatePow;

    vec3 baseColor = cloudMat.albedo.rgb * densitySample;

    if (${this.getShaderOptionBoolean('cIsMultVertexColor')}) {
        baseColor *= v_VtxColor.rgb;
    }

    vec3 directLight = diffuse * phase * vec3(1.0);
    
    // vec3 ambientLight = vec3(0.1) * cloudMat.cIndirectScale.x; 
    // TODO: cIndirectScale is pure black

    vec3 ambientLight = vec3(0.8);

    // vec3 finalRGB = ambientLight * (directLight * baseColor); // broken

    vec3 finalRGB = ambientLight;

    float alpha = densitySample * cloudMat.albedo.a;
    
    if (${this.getShaderOptionBoolean('cIsMultVertexColor')}) {
        alpha *= v_VtxColor.a;
    }

    gl_FragColor = vec4(finalRGB, alpha);
}
`;
}
}