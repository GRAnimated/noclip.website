import { AglProgram } from './Render.js';

export function generateSkyFragmentShader(program: AglProgram): string {
    return `
precision mediump float;

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

void main() {
    vec4 base_color           = ${program.genSample('_a0', 'v_TexCoord0')};

    gl_FragColor = vec4(base_color.rgb, base_color.a);

    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(1.0 / 2.2));
}
`;
}
