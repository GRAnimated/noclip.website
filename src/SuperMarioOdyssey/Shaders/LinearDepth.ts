import { GfxBindingLayoutDescriptor, GfxSamplerFormatKind, GfxTextureDimension } from '../../gfx/platform/GfxPlatform.js';
import { DeviceProgram } from '../../Program.js';
import { generateShaderUtil } from './ShaderUtil.js';

export class LinearDepth extends DeviceProgram {
    public static ub_LinearDepthInfo = 0;

    public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
        {
            numUniformBuffers: 1, numSamplers: 1, samplerEntries: [
                { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat },
            ],
        },
    ];

    public override both = generateShaderUtil() + `
layout(std140) uniform ub_LinearDepthInfo {
    float uNear;
    float uFar;
    vec2  uPadding0;
};

uniform sampler2D uDepthTexture;
`;

    public override vert = `
layout(location = 0) in vec4 aPosition;
layout(location = 1) in vec2 aTexCoord;

out vec2 vTexCoord;

void main() {
    gl_Position = aPosition;
    vTexCoord = aTexCoord;
}
`;

    public override frag = `
in vec2 vTexCoord;
out vec4 oColor;

float DepthToLinear(float depth, float near, float far) {
    // noclip uses reversed depth
    float z = 1.0 - depth * 2.0;
    float linear = (2.0 * near * far) / (far + near - z * (far - near));
    return (linear - near) / (far - near);
}

void main() {
    float depth = texture(uDepthTexture, vTexCoord).r;

    float linearDepth = DepthToLinear(depth, uNear, uFar);

    oColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
}
`;
}