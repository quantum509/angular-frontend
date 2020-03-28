export const environment = {
    production: true,
    loginConfig: {
      GLUU_URL: 'https://idp-d.gsu.edu/',
      GLUU_CLIENT: '@!18B2.0B8D.E469.44F9!0001!B391.7220!0008!8F37.82D6.B56D.B3F4',
      GLUU_LOGIN_REDIRECT: 'http://localhost:8100/#/login?mode=redirect',
      GLUU_LOGIN_SILENT: 'http://localhost:8100/#/login?mode=silent',
      GLUU_LOGIN_POPUP: 'http://localhost:8100/#/login?mode=popup',
      GLUU_REDIRECT_LOGOUT: 'http://localhost:8100/#/login?mode=logout',
      SCOPE: 'openid gsUser profile gsupersonpantherid'
    }
};


