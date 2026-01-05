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
    
    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(mdlEnvView.HDRTranslate_uHDRPower / mdlEnvView.HDRTranslate_uDynamicRange));
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
    vec3 viewPos = multMtx34Vec3(u_ModelView, _p0);
    vec4 clip = multMtx44Vec3(u_Projection, viewPos);

    gl_Position = vec4(clip.xy, clip.z, clip.w);
    
    v_TexCoord0 = _u0;
}
`;

}}
