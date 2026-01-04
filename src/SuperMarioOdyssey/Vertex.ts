import { AglProgram } from './Render.js';

export function generateVertexShader(program: AglProgram): string {
    return `
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

    vec4 view_pos = multMtx34Vec4(mdlEnvView.cView, vec4(_p0, 1.0));
    v_ViewPos.zw = view_pos.xy;
    v_LightColorVPosZ.w = view_pos.z;

    // Calculate light color
    vec3 light_color = vec3(1.0); // TEMP
    
    // vec3 light_color = textureLod(cDirectionalLightColor, vec2(mdlEnvView.cDirLightViewDirFetchPos.w, 0.5), 0.0).xyz;
    
    v_LightColorVPosZ.xyz = light_color;

    const float MAX_LOD = 5.0;
   
    if (${program.getShaderOptionBoolean('is_apply_irradiance_pixel')} == false)
    {
        if (${program.getShaderOptionBoolean('enable_material_light')}) // use material light cubemap
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
}
