import { GfxBindingLayoutDescriptor, GfxSamplerFormatKind, GfxTextureDimension } from '../../gfx/platform/GfxPlatform.js';
import { DeviceProgram } from '../../Program.js';
import { fillMatrix4x3 } from '../../gfx/helpers/UniformBufferHelpers.js';
import { generateShaderUtil } from './ShaderUtil.js';

export function fillRenderFogUniforms(d: Float32Array, offs: number, preset: any, viewerInput: any): number {
    const fog = preset?.Fog ?? {};
    const yFog = preset?.YFog ?? {};
    const fogColor = fog.Color ?? { R: 0, G: 0, B: 0 };
    const yFogColor = yFog.Color ?? { R: 0, G: 0, B: 0 };

    d[offs++] = fogColor.R ?? 0.0;
    d[offs++] = fogColor.G ?? 0.0;
    d[offs++] = fogColor.B ?? 0.0;
    d[offs++] = fog.IsEnable ? (fog.Slope ?? 0.0) * 0.001 : 0.0;

    // FogDirector::updateViewGpu writes cFogStart = -Fog.Start
    d[offs++] = -(fog.Start ?? 0.0);
    d[offs++] = fog.Max ?? 1.0;
    d[offs++] = fog.IsEnable ? 1.0 : 0.0;
    d[offs++] = fog.IsDeferredFog ? 1.0 : 0.0;

    d[offs++] = yFogColor.R ?? 0.0;
    d[offs++] = yFogColor.G ?? 0.0;
    d[offs++] = yFogColor.B ?? 0.0;
    d[offs++] = yFog.IsEnable ? (yFog.Slope ?? 0.0) * 0.001 : 0.0;

    d[offs++] = yFog.Start ?? 0.0;
    d[offs++] = yFog.Max ?? 1.0;
    d[offs++] = yFog.IsEnable ? 1.0 : 0.0;
    d[offs++] = yFog.IsDeferredFog ? 1.0 : 0.0;

    // TODO: cViewAxisY and cViewAxisZ equivalent for our world-axis Y fog approximation
    d[offs++] = 0.0; d[offs++] = 1.0; d[offs++] = 0.0; d[offs++] = 0.0;
    d[offs++] = 0.0; d[offs++] = 0.0; d[offs++] = 1.0; d[offs++] = 0.0;

    d[offs++] = yFog.DistanceSlope ?? 0.0;
    d[offs++] = yFog.DistanceSlopeScale ?? 0.0;
    d[offs++] = yFog.BlendType ?? 0.0;
    d[offs++] = fog.IsBlendMult || yFog.IsBlendMult ? 1.0 : 0.0;

    d[offs++] = viewerInput.camera.near;
    d[offs++] = viewerInput.camera.far;
    d[offs++] = viewerInput.camera.far - viewerInput.camera.near;
    d[offs++] = 1.0 / (viewerInput.camera.far - viewerInput.camera.near);

    d[offs++] = viewerInput.camera.right / viewerInput.camera.near;
    d[offs++] = viewerInput.camera.top / viewerInput.camera.near;
    d[offs++] = 0.0;
    d[offs++] = 0.0;

    offs += fillMatrix4x3(d, offs, viewerInput.camera.worldMatrix);

    // cSkyParam
    d[offs++] = fog.IsApplySky ? 1.0 : 0.0;
    d[offs++] = fog.SkyMip ?? 0.0;
    d[offs++] = 0.0;
    d[offs++] = 0.0;

    return offs;
}

export class RenderFog extends DeviceProgram {
    public static ub_RenderFogInfo = 0;

    public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
        {
            numUniformBuffers: 1, numSamplers: 2, samplerEntries: [
                { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat },
                { dimension: GfxTextureDimension.Cube, formatKind: GfxSamplerFormatKind.Float },
            ],
        },
    ];

    public override both = generateShaderUtil() + `
layout(std140) uniform ub_RenderFogInfo {
    vec4 cFogColor;
    vec4 cFogParam;     // x=start, y=max, z=enable, w=deferred
    vec4 cYFogColor;
    vec4 cYFogParam;    // x=start, y=max, z=enable, w=deferred
    vec4 cViewAxisY;
    vec4 cViewAxisZ;
    vec4 cYFogExtra;    // x=DistanceSlope, y=DistanceSlopeScale, z=BlendType, w=IsBlendMult
    vec4 cDepthParam;   // x=near, y=far, z=range, w=invRange
    vec4 cScreenParam;  // xy=tan(fovy/2), zw=proj offset
    vec4 cInvView[3];
    vec4 cSkyParam;     // x=fog.IsApplySky, y=fog.SkyMip, zw=padding
};

uniform sampler2D uLinearDepth;
uniform samplerCube uSkyCube;
`;

    public override vert = `
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aTexCoord;

out vec2 vTexCoord;
out vec2 vScreen;

void main() {
    gl_Position = vec4(aPosition.xy, 0.0, 1.0);
    vTexCoord = aTexCoord;
    vScreen = gl_Position.xy;
    vScreen.xy *= -cScreenParam.xy;
    vScreen.xy -= cScreenParam.zw;
}
`;

    public override frag = `
in vec2 vTexCoord;
in vec2 vScreen;
out vec4 oColor;

void main() {
    float depth = texture(uLinearDepth, vTexCoord).r;
    if (depth >= 0.999999)
        discard;

    vec3 view_pos;
    view_pos.z = -(depth * cDepthParam.z + cDepthParam.x);
    view_pos.xy = vScreen * view_pos.z;

    float fog_intensity = 0.0;
    if (cFogParam.z > 0.5 && cFogParam.w > 0.5) {
        float fog_dist_intensity = cFogColor.a * (-view_pos.z + cFogParam.x);
        fog_intensity = clamp(clamp(1.0 - exp2(-fog_dist_intensity), 0.0, 1.0) * cFogParam.y, 0.0, 1.0);
    }

    float y_fog_intensity = 0.0;
    if (cYFogParam.z > 0.5 && cYFogParam.w > 0.5) {
        vec3 world_pos;
        world_pos.x = dot(cInvView[0], vec4(view_pos, 1.0));
        world_pos.y = dot(cInvView[1], vec4(view_pos, 1.0));
        world_pos.z = dot(cInvView[2], vec4(view_pos, 1.0));

        float dot_y = world_pos.y;
        float fog_start = cYFogParam.x - 1.0;
        float y_fog_dist_intensity = cYFogColor.a * (-dot_y + fog_start);
        y_fog_intensity = clamp(clamp(1.0 - exp2(-y_fog_dist_intensity), 0.0, 1.0) * cYFogParam.y, 0.0, 1.0);

        if (int(cYFogExtra.x) == 1) {
            y_fog_intensity *= clamp(exp2(view_pos.z * cYFogExtra.y), 0.0, 1.0);
        } else if (int(cYFogExtra.x) == 2) {
            y_fog_intensity *= clamp(1.0 - exp2(view_pos.z * cYFogExtra.y), 0.0, 1.0);
        }
    }

    if (fog_intensity + y_fog_intensity < 0.00001)
        discard;

    float sum_fog = fog_intensity + y_fog_intensity + 0.00001;
    float mix_rate = fog_intensity / sum_fog;
    vec3 final_fog_color = mix(cYFogColor.rgb, cFogColor.rgb, mix_rate);
    float transmittance = clamp((1.0 - fog_intensity) * (1.0 - y_fog_intensity), 0.0, 1.0);

    if (cSkyParam.x > 0.5) {
        vec3 eye_to_pos = normalize(view_pos);
        vec3 fetch_dir = rotMtx33Vec3(cInvView, eye_to_pos);
        final_fog_color = final_fog_color * fetchCubeMapConvertHdr(uSkyCube, fetch_dir, cSkyParam.y).rgb;
    }

    oColor = vec4(final_fog_color, 1.0 - transmittance);
}
`;
}
