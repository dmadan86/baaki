require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json'))) rescue { 'version' => '1.0.0' }

Pod::Spec.new do |s|
  s.name           = 'WavesWatch'
  s.version        = package['version'] || '1.0.0'
  s.summary        = 'WatchConnectivity bridge for the Waves Apple Watch companion.'
  s.description    = 'Relays quick-add / voice / recent intents between the phone app and its watchOS companion.'
  s.author         = 'Waves'
  s.homepage       = 'https://waves.app'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
