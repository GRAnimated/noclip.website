import { AglProgram } from './Render.js';

export function generateSkyFragmentShader(program: AglProgram): string {
    return `
precision mediump float;

in vec2 v_TexCoord0;

void main() {
    vec4 base_color = ${program.genSample('_a0', 'v_TexCoord0')};

    float scale = pow(base_color.a, mdlEnvView.HDRTranslate_uHDRPower) * mdlEnvView.HDRTranslate_uDynamicRange;
    base_color.rgb *= scale;
    
    gl_FragColor = vec4(base_color.rgb, 1.0);
    
    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(mdlEnvView.HDRTranslate_uHDRPower / mdlEnvView.HDRTranslate_uDynamicRange));
}
`;
}
