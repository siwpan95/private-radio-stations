// 热加载演示插件（P8A：entry 需 hot: true 才允许动态增删）
import { Service } from 'cordis'

class HelloService extends Service {
  constructor(ctx, cfg) {
    super(ctx, 'hello')
    this.greeting = (cfg && cfg.greeting) || 'hello from hot plugin'
    ctx.logger.info('[hello] loaded: ' + this.greeting)
  }
}

export default function helloPlugin(ctx, cfg) {
  ctx.plugin(HelloService, cfg)
}
