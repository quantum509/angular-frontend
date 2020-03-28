import { Component } from '@angular/core';
import { LoginService, User, LoginConfig } from '../login-service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
})
export class AppComponent {
  title = 'login-app';
  user: User;
  constructor(
    private loginService: LoginService
  ) {
    this.loginService
      .initialize(environment.loginConfig)
      .then(() => this.loginService.getCurrentUser())
      .then((user: User) => this.user = user)
      .catch(() => console.error('Silent Login Failed'));
  }

  login() {
    this.loginService
      .getUserOrLogin()
      .then((user: User) => this.user = user);
  }
  logout() {
    this.loginService.logOut();
  }
}
