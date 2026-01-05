import { GfxShaderLibrary } from "../../gfx/helpers/GfxShaderLibrary";

export function generateShaderUtil(): string {
    return `
${GfxShaderLibrary.saturate}

const float PI = 3.1415926535897932384626433832795;
const float INV_PI = 0.31830988618;
const float EULERS_NUMBER = 2.71828182845904;

float fma(float a, float b, float c) {
    return (a * b) + c;
}

vec3 fma(vec3 a, vec3 b, vec3 c) {
    return (a * b) + c;
}

vec4 fma(vec4 a, vec4 b, vec4 c) {
    return (a * b) + c;
}

#define clamp01(val)	clamp((val), 0.0, 1.0)
#define dot2(a, b)	((a).x * (b).x + (a).y * (b).y)
#define dot3(a, b)	(dot2((a), (b)) + (a).z * (b).z)
#define dot4(a, b)	(dot3((a), (b)) + (a).w * (b).w)
#define calcDotVec4Vec3One(a, b)	(dot3((a), (b)) + (a).w)

vec4 multMtx44Vec4(Mat4x4 mtx, vec4 v)
{
    vec4 ret;
    ret.x = dot(mtx.mx, v);
    ret.y = dot(mtx.my, v);
    ret.z = dot(mtx.mz, v);
    ret.w = dot(mtx.mw, v);
    return ret;
}

vec4 multMtx44Vec3(Mat4x4 mtx, vec3 v)
{
    vec4 ret;
    ret.x = calcDotVec4Vec3One(mtx.mx, v);
    ret.y = calcDotVec4Vec3One(mtx.my, v);
    ret.z = calcDotVec4Vec3One(mtx.mz, v);
    ret.w = calcDotVec4Vec3One(mtx.mw, v);
    return ret;
}

vec4 multMtx34Vec4(Mat3x4 mtx, vec4 v)
{
    vec4 ret;
    ret.x = dot(mtx.mx, v);
    ret.y = dot(mtx.my, v);
    ret.z = dot(mtx.mz, v);
    ret.w = 1.0;
    return ret;
}

vec3 multMtx34Vec3(Mat3x4 mtx, vec3 v)
{
    vec3 ret;
    ret.x = calcDotVec4Vec3One(mtx.mx, v);
    ret.y = calcDotVec4Vec3One(mtx.my, v);
    ret.z = calcDotVec4Vec3One(mtx.mz, v);
    return ret;
}

vec3 rotMtx34Vec3(Mat3x4 mtx, vec3 v)
{
    vec3 ret;
    ret.x = dot3(mtx.mx, v);
    ret.y = dot3(mtx.my, v);
    ret.z = dot3(mtx.mz, v);
    return ret;
}

vec2 multMtx24Vec2(Mat2x4 mtx, vec2 v)
{
    return vec2(mtx.mx.xy * v.x + mtx.mx.zw * v.y + mtx.my.xy);
}

const float ENCODE_BASE	= 0.25;

void CalcHdrToLdr(out vec4 ldr, vec4 hdr) {
    float head_value = max(max(hdr.r, hdr.g), hdr.b);
    const float base_rcp = 1.0 / ENCODE_BASE;
    head_value += fract(1.0 - (head_value * base_rcp)) * ENCODE_BASE;
    head_value = max(head_value, 1.0 / 256.0);
    float texel_correct_value = clamp01(head_value / mdlEnvView.HDRTranslate_uDynamicRange);
    texel_correct_value = pow(texel_correct_value, 1.0 / mdlEnvView.HDRTranslate_uHDRPower);
    ldr.rgb = hdr.rgb / head_value;
    ldr.a = texel_correct_value;
}

void CalcLdrToHdr(out vec4 hdr, vec4 ldr) {
    float scale = pow(ldr.a, mdlEnvView.HDRTranslate_uHDRPower) * mdlEnvView.HDRTranslate_uDynamicRange;
    hdr = vec4(ldr.rgb * scale, scale);
}

vec4 fetchCubeMap(samplerCube cube, vec3 dir, float bias) {
    vec4 tex = textureLod(cube, dir, bias);
    return tex;
}

vec4 fetchCubeMapConvertHdr(samplerCube cube, vec3 dir, float bias) {
    vec4 tex = textureLod(cube, dir, bias);

    CalcLdrToHdr(tex, tex);
    return tex;
}

vec4 fetchCubeMapIrradiance(samplerCube cube, vec3 dir) {
    vec4 tex = textureLod(cube, dir, 5.0);
    return tex;
}

vec4 fetchCubeMapIrradianceConvertHdr(samplerCube cube, vec3 dir) {
    vec4 tex = textureLod(cube, dir, 5.0);

    CalcLdrToHdr(tex, tex);
    return tex;
}
`
};
