export function generateVertexShader(): string {
    return `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;

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

    vec4 view_pos = multMtx34Vec4(mdlEnvView.cView, vec4(_p0, 1.0));
    v_ViewPos.zw = view_pos.xy;
    v_LightColorVPosZ.w = view_pos.z;

    v_TexCoord0 = _u0;
    v_VtxColor = _c0;
    v_Normal = _n0.xyz;
    v_Tangents = _t0;
}
`;
}
