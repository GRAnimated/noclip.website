import { FMAT } from "../../fres_nx/bfres.js";
import { MaterialUniforms, OdysseyProgram, ubMaterial, ubMdlEnvView, ubModelAdditionalInfo, ubShapeParams } from "../OdysseyProgram.js";
import { generateShaderUtil } from "./ShaderUtil.js";

export class RenderSky extends OdysseyProgram {
    constructor(fmat: FMAT) {
        super(fmat);
   
this.both += `
${ubShapeParams}
${ubMdlEnvView}
${ubMaterial}
${ubModelAdditionalInfo}
${MaterialUniforms}
`;

this.frag =
`in vec2 v_TexCoord0;

void main() {
    vec4 base_color = ${this.genSample('_a0', 'v_TexCoord0')};

    float scale = pow(base_color.a, mdlEnvView.HDRTranslate_uHDRPower) * mdlEnvView.HDRTranslate_uDynamicRange;
    base_color.rgb *= scale;
    
    gl_FragColor = vec4(base_color.rgb, 1.0);
}
`;

this.vert =
`
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;

out vec2 v_TexCoord0;

void main() {
    Mat3x4 view = u_View;

    view.mx.w = 0.0;
    view.my.w = 0.0;
    view.mz.w = 0.0;

    vec3 worldPos = UnpackMatrix(u_Model) * vec4(_p0, 1.0);
    vec3 viewPos = UnpackMatrix(view) * vec4(worldPos, 1.0);
    vec4 clip = UnpackMatrix(u_Projection) * vec4(viewPos, 1.0);

    gl_Position = vec4(clip.xy, clip.z, clip.w);
    
    v_TexCoord0 = _u0;
}
`;

}}
